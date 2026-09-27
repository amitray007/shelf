#import <Foundation/Foundation.h>
#import <sys/stat.h>

static NSURL *stateFile(void) {
  NSString *override = NSProcessInfo.processInfo.environment[@"SHELF_DESKTOP_DATA_DIR"];
  NSURL *directory;
  if (override.length) directory = [NSURL fileURLWithPath:override isDirectory:YES];
  else directory = [[[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject] URLByAppendingPathComponent:@"Shelf Desktop" isDirectory:YES];
  return [directory URLByAppendingPathComponent:@"session.json"];
}

// Missing state is normal. Other read failures return SIZE_MAX and preserve the file.
size_t shelf_state_read(char *buffer, size_t capacity) {
  NSURL *file = stateFile();
  if (![NSFileManager.defaultManager fileExistsAtPath:file.path]) return 0;
  NSError *error = nil;
  NSData *data = [NSData dataWithContentsOfURL:file options:0 error:&error];
  if (!data || data.length == 0 || data.length > 8 * 1024 * 1024) return SIZE_MAX;
  if (buffer && capacity >= data.length) memcpy(buffer, data.bytes, data.length);
  return data.length;
}

int shelf_state_write(const char *buffer, size_t length) {
  NSURL *file = stateFile();
  NSURL *directory = [file URLByDeletingLastPathComponent];
  NSError *error = nil;
  if (![NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:&error]) return 0;
  // Capability-bearing URLs stay in a private directory, including during atomic replacement.
  if (chmod(directory.fileSystemRepresentation, 0700) != 0) return 0;
  NSData *data = [NSData dataWithBytes:buffer length:length];
  if (![data writeToURL:file options:NSDataWritingAtomic error:&error]) return 0;
  return chmod(file.fileSystemRepresentation, 0600) == 0;
}
