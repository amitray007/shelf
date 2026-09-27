#import <Foundation/Foundation.h>
#import <sqlite3.h>

#import "link_cache.h"

#include <limits.h>
#include <errno.h>
#include <sys/stat.h>

static sqlite3 *database;
static sqlite3_stmt *putStatement;
static sqlite3_stmt *readStatement;
static sqlite3_stmt *findStatement;
static sqlite3_stmt *deactivateStatement;
static sqlite3_stmt *activateStatement;
static sqlite3_stmt *searchStatement;
static sqlite3_stmt *bodyStatement;
static sqlite3_stmt *bodyLengthStatement;

static NSURL *cacheDirectory(void) {
  NSString *override = NSProcessInfo.processInfo.environment[@"SHELF_DESKTOP_DATA_DIR"];
  if (override.length) return [NSURL fileURLWithPath:override isDirectory:YES];
  return [[[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                 inDomains:NSUserDomainMask] firstObject]
      URLByAppendingPathComponent:@"Shelf Desktop" isDirectory:YES];
}

static void reset(sqlite3_stmt *statement) {
  sqlite3_reset(statement);
  sqlite3_clear_bindings(statement);
}

static int prepare(sqlite3_stmt **statement, const char *sql) {
  return sqlite3_prepare_v2(database, sql, -1, statement, NULL) == SQLITE_OK;
}

static int makePrivateFile(const char *path, mode_t mode, int required) {
  if (chmod(path, mode) == 0) return 1;
  return !required && errno == ENOENT;
}

static int makePrivate(NSURL *directory) {
  if (chmod(directory.fileSystemRepresentation, 0700) != 0) return 0;
  NSURL *databaseFile = [directory URLByAppendingPathComponent:@"link-cache.sqlite3"];
  return makePrivateFile(databaseFile.fileSystemRepresentation, 0600, 1) &&
         makePrivateFile([[databaseFile.path stringByAppendingString:@"-wal"] fileSystemRepresentation], 0600, 0) &&
         makePrivateFile([[databaseFile.path stringByAppendingString:@"-shm"] fileSystemRepresentation], 0600, 0);
}

static int execute(const char *sql) {
  return sqlite3_exec(database, sql, NULL, NULL, NULL) == SQLITE_OK;
}

static void containsIgnoringCase(sqlite3_context *context, int count, sqlite3_value **values) {
  if (count != 2 || sqlite3_value_type(values[0]) == SQLITE_NULL || sqlite3_value_type(values[1]) == SQLITE_NULL) {
    sqlite3_result_int(context, 0);
    return;
  }
  const unsigned char *haystackBytes = sqlite3_value_text(values[0]);
  const unsigned char *needleBytes = sqlite3_value_text(values[1]);
  NSString *haystack = haystackBytes ? [NSString stringWithUTF8String:(const char *)haystackBytes] : nil;
  NSString *needle = needleBytes ? [NSString stringWithUTF8String:(const char *)needleBytes] : nil;
  sqlite3_result_int(context, haystack && needle && [haystack rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound);
}

int shelf_link_cache_open(void) {
  if (database) return 1;

  NSURL *directory = cacheDirectory();
  NSError *error = nil;
  if (![NSFileManager.defaultManager createDirectoryAtURL:directory
                              withIntermediateDirectories:YES
                                               attributes:@{NSFilePosixPermissions: @0700}
                                                    error:&error] ||
      chmod(directory.fileSystemRepresentation, 0700) != 0) return 0;

  NSURL *file = [directory URLByAppendingPathComponent:@"link-cache.sqlite3"];
  if (sqlite3_open_v2(file.fileSystemRepresentation, &database,
                      SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                      NULL) != SQLITE_OK) {
    shelf_link_cache_close();
    return 0;
  }

  if (sqlite3_create_function_v2(database, "shelf_contains", 2, SQLITE_UTF8 | SQLITE_DETERMINISTIC,
                                 NULL, containsIgnoringCase, NULL, NULL, NULL) != SQLITE_OK) {
    shelf_link_cache_close();
    return 0;
  }

  // This database is derived from session.json. Never retain stale links or page text.
  if (!execute("PRAGMA journal_mode=WAL;") ||
      !execute("PRAGMA synchronous=NORMAL;") ||
      !execute("PRAGMA cache_size=-2048;") ||
      !execute("PRAGMA temp_store=MEMORY;") ||
      !execute("DROP TABLE IF EXISTS links;") ||
      !execute("CREATE TABLE links (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 0);") ||
      !execute("CREATE INDEX links_active ON links(active); CREATE INDEX links_url ON links(url);") ||
      !prepare(&putStatement, "INSERT INTO links(id, url, title) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET url=excluded.url, title=excluded.title;") ||
      !prepare(&readStatement, "SELECT url, title FROM links WHERE id=?;") ||
      !prepare(&findStatement, "SELECT id FROM links WHERE url=? ORDER BY active DESC, id DESC LIMIT 1;") ||
      !prepare(&deactivateStatement, "UPDATE links SET active=0;") ||
      !prepare(&activateStatement, "UPDATE links SET active=1 WHERE id=?;") ||
      !prepare(&searchStatement, "SELECT id FROM links WHERE active=1 AND (shelf_contains(title, ?) OR shelf_contains(url, ?) OR shelf_contains(body, ?)) ORDER BY id LIMIT ?;") ||
      !prepare(&bodyStatement, "UPDATE links SET body=CASE WHEN ?='' THEN '' ELSE body || ? END WHERE id=?;") ||
      !prepare(&bodyLengthStatement, "SELECT length(CAST(body AS BLOB)) FROM links WHERE id=?;")) {
    shelf_link_cache_close();
    return 0;
  }
  if (!makePrivate(directory)) {
    shelf_link_cache_close();
    return 0;
  }
  return 1;
}

void shelf_link_cache_close(void) {
  sqlite3_finalize(putStatement); putStatement = NULL;
  sqlite3_finalize(readStatement); readStatement = NULL;
  sqlite3_finalize(findStatement); findStatement = NULL;
  sqlite3_finalize(deactivateStatement); deactivateStatement = NULL;
  sqlite3_finalize(activateStatement); activateStatement = NULL;
  sqlite3_finalize(searchStatement); searchStatement = NULL;
  sqlite3_finalize(bodyStatement); bodyStatement = NULL;
  sqlite3_finalize(bodyLengthStatement); bodyLengthStatement = NULL;
  if (database) sqlite3_close(database);
  database = NULL;
}

int shelf_link_cache_put(uint64_t id, const char *url, const char *title) {
  if (!database || !url || !title) return 0;
  if (sqlite3_bind_int64(putStatement, 1, (sqlite3_int64)id) != SQLITE_OK ||
      sqlite3_bind_text(putStatement, 2, url, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
      sqlite3_bind_text(putStatement, 3, title, -1, SQLITE_TRANSIENT) != SQLITE_OK) {
    reset(putStatement);
    return 0;
  }
  int success = sqlite3_step(putStatement) == SQLITE_DONE;
  reset(putStatement);
  return success;
}

static NSString *jsonString(NSString *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@[value] options:0 error:nil];
  if (!data || data.length < 2) return nil;
  return [[NSString alloc] initWithBytes:data.bytes + 1 length:data.length - 2 encoding:NSUTF8StringEncoding];
}

size_t shelf_link_cache_read(uint64_t id, char *buffer, size_t capacity) {
  if (!database) return SIZE_MAX;
  if (sqlite3_bind_int64(readStatement, 1, (sqlite3_int64)id) != SQLITE_OK) return SIZE_MAX;
  int result = sqlite3_step(readStatement);
  if (result == SQLITE_DONE) {
    reset(readStatement);
    return 0;
  }
  if (result != SQLITE_ROW) {
    reset(readStatement);
    return SIZE_MAX;
  }
  NSString *url = [NSString stringWithUTF8String:(const char *)sqlite3_column_text(readStatement, 0)];
  NSString *title = [NSString stringWithUTF8String:(const char *)sqlite3_column_text(readStatement, 1)];
  NSString *encodedURL = jsonString(url);
  NSString *encodedTitle = jsonString(title);
  if (!encodedURL || !encodedTitle) {
    reset(readStatement);
    return SIZE_MAX;
  }
  NSString *payload = [NSString stringWithFormat:@"{\"url\":%@,\"title\":%@}", encodedURL, encodedTitle];
  NSData *data = [payload dataUsingEncoding:NSUTF8StringEncoding];
  size_t length = data.length;
  if (buffer && capacity >= length) memcpy(buffer, data.bytes, length);
  reset(readStatement);
  return length;
}

uint64_t shelf_link_cache_find_url(const char *url) {
  if (!database || !url || sqlite3_bind_text(findStatement, 1, url, -1, SQLITE_TRANSIENT) != SQLITE_OK) return UINT64_MAX;
  int result = sqlite3_step(findStatement);
  if (result == SQLITE_DONE) {
    reset(findStatement);
    return 0;
  }
  if (result != SQLITE_ROW) {
    reset(findStatement);
    return UINT64_MAX;
  }
  uint64_t id = (uint64_t)sqlite3_column_int64(findStatement, 0);
  reset(findStatement);
  return id;
}

int shelf_link_cache_set_active(const uint64_t *ids, size_t count) {
  if (!database || (count && !ids) || !execute("BEGIN IMMEDIATE;")) return 0;
  int success = sqlite3_step(deactivateStatement) == SQLITE_DONE;
  reset(deactivateStatement);
  for (size_t index = 0; success && index < count; index++) {
    success = sqlite3_bind_int64(activateStatement, 1, (sqlite3_int64)ids[index]) == SQLITE_OK &&
              sqlite3_step(activateStatement) == SQLITE_DONE;
    reset(activateStatement);
  }
  if (!execute(success ? "COMMIT;" : "ROLLBACK;")) {
    execute("ROLLBACK;");
    return 0;
  }
  return success;
}

size_t shelf_link_cache_search(const char *query, uint64_t *ids, size_t capacity) {
  if (!database || !query || (capacity && !ids)) return SIZE_MAX;
  if (capacity == 0) return 0;
  sqlite3_int64 limit = capacity > INT64_MAX ? INT64_MAX : (sqlite3_int64)capacity;
  if (sqlite3_bind_text(searchStatement, 1, query, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
      sqlite3_bind_text(searchStatement, 2, query, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
      sqlite3_bind_text(searchStatement, 3, query, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
      sqlite3_bind_int64(searchStatement, 4, limit) != SQLITE_OK) {
    reset(searchStatement);
    return SIZE_MAX;
  }
  size_t count = 0;
  int result;
  while ((result = sqlite3_step(searchStatement)) == SQLITE_ROW) ids[count++] = (uint64_t)sqlite3_column_int64(searchStatement, 0);
  reset(searchStatement);
  return result == SQLITE_DONE ? count : SIZE_MAX;
}

int shelf_link_cache_body(uint64_t id, const char *body) {
  if (!database || !body) return 0;
  NSString *incoming = [[NSString alloc] initWithUTF8String:body];
  if (!incoming) return 0;
  NSData *incomingBytes = [incoming dataUsingEncoding:NSUTF8StringEncoding];
  if (incomingBytes.length == 0) {
    if (sqlite3_bind_text(bodyStatement, 1, "", 0, SQLITE_STATIC) != SQLITE_OK ||
        sqlite3_bind_text(bodyStatement, 2, "", 0, SQLITE_STATIC) != SQLITE_OK ||
        sqlite3_bind_int64(bodyStatement, 3, (sqlite3_int64)id) != SQLITE_OK) {
      reset(bodyStatement);
      return 0;
    }
    int success = sqlite3_step(bodyStatement) == SQLITE_DONE && sqlite3_changes(database) == 1;
    reset(bodyStatement);
    return success;
  }
  if (sqlite3_bind_int64(bodyLengthStatement, 1, (sqlite3_int64)id) != SQLITE_OK ||
      sqlite3_step(bodyLengthStatement) != SQLITE_ROW) {
    reset(bodyLengthStatement);
    return 0;
  }
  sqlite3_int64 existing = sqlite3_column_int64(bodyLengthStatement, 0);
  reset(bodyLengthStatement);
  if (existing < 0 || existing >= 65536) return existing == 65536;
  size_t available = 65536 - (size_t)existing;
  size_t length = MIN(incomingBytes.length, available);
  while (length > 0 && ![[NSString alloc] initWithBytes:incomingBytes.bytes length:length encoding:NSUTF8StringEncoding]) length--;
  if (length == 0) return 1;
  if (sqlite3_bind_text(bodyStatement, 1, "append", -1, SQLITE_STATIC) != SQLITE_OK ||
      sqlite3_bind_text(bodyStatement, 2, incomingBytes.bytes, (int)length, SQLITE_TRANSIENT) != SQLITE_OK ||
      sqlite3_bind_int64(bodyStatement, 3, (sqlite3_int64)id) != SQLITE_OK) {
    reset(bodyStatement);
    return 0;
  }
  int success = sqlite3_step(bodyStatement) == SQLITE_DONE && sqlite3_changes(database) == 1;
  reset(bodyStatement);
  return success;
}
