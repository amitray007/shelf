#import <Foundation/Foundation.h>

#import "link_cache.h"

#include <assert.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void expectSearch(const char *query, uint64_t expected) {
  uint64_t ids[4] = {0};
  assert(shelf_link_cache_search(query, ids, 4) == 1);
  assert(ids[0] == expected);
}

int main(void) {
  char temporary[] = "/tmp/shelf-link-cache-test.XXXXXX";
  assert(mkdtemp(temporary));
  assert(setenv("SHELF_DESKTOP_DATA_DIR", temporary, 1) == 0);
  assert(shelf_link_cache_open());
  assert(shelf_link_cache_put(1, "https://example.test/path#fragment", "First \"link\""));
  assert(shelf_link_cache_put(2, "https://example.test/other", "Caf\303\251"));
  assert(shelf_link_cache_find_url("https://example.test/path#fragment") == 1);
  assert(shelf_link_cache_find_url("https://example.test/missing") == 0);

  size_t required = shelf_link_cache_read(1, NULL, 0);
  assert(required > 0 && required != SIZE_MAX);
  char payload[256] = {0};
  assert(shelf_link_cache_read(1, payload, sizeof(payload)) == required);
  assert(strstr(payload, "path#fragment") && strstr(payload, "First \\\"link\\\""));
  assert(shelf_link_cache_read(99, NULL, 0) == 0);

  uint64_t active[] = {1, 2};
  assert(shelf_link_cache_set_active(active, 2));
  assert(shelf_link_cache_body(1, "The quick brown "));
  assert(shelf_link_cache_body(1, "fox"));
  assert(shelf_link_cache_body(2, "Quoted ' OR 1=1 -- query text"));
  expectSearch("BROWN", 1);
  expectSearch("caf\303\251", 2);
  uint64_t one[1] = {0};
  assert(shelf_link_cache_search("https://example.test", one, 1) == 1);
  assert(shelf_link_cache_search("' OR 1=1 --", one, 1) == 1);
  assert(shelf_link_cache_set_active(active, 1));
  assert(shelf_link_cache_search("other", one, 1) == 0);
  assert(shelf_link_cache_body(1, ""));
  assert(shelf_link_cache_search("brown", one, 1) == 0);
  char *large = malloc(65536);
  assert(large);
  memset(large, 'a', 65535);
  large[65535] = '\0';
  assert(shelf_link_cache_body(1, large));
  assert(shelf_link_cache_body(1, "\303\251"));
  assert(shelf_link_cache_search("\303\251", one, 1) == 0);
  free(large);

  struct stat info;
  assert(stat(temporary, &info) == 0 && (info.st_mode & 0777) == 0700);
  NSString *database = [NSString stringWithFormat:@"%s/link-cache.sqlite3", temporary];
  assert(stat(database.fileSystemRepresentation, &info) == 0 && (info.st_mode & 0777) == 0600);
  shelf_link_cache_close();
  assert(shelf_link_cache_open());
  assert(shelf_link_cache_read(1, NULL, 0) == 0);
  shelf_link_cache_close();
  return 0;
}
