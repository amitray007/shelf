#import <Foundation/Foundation.h>
#import <sys/stat.h>
extern size_t shelf_state_read(char *, size_t);
extern int shelf_state_write(const char *, size_t);
int main(void) {
  @autoreleasepool {
    NSString *directory = NSProcessInfo.processInfo.environment[@"SHELF_DESKTOP_DATA_DIR"];
    NSCAssert(directory.length && [directory hasPrefix:NSTemporaryDirectory()], @"Use a disposable test directory");
    NSCAssert(shelf_state_read(NULL, 0) == 0, @"A missing session is empty");
    const char *snapshot = "{\"version\":1}";
    NSCAssert(shelf_state_write(snapshot, strlen(snapshot)) == 1, @"Write succeeds");
    char buffer[128] = {0};
    NSCAssert(shelf_state_read(buffer, sizeof(buffer)) == strlen(snapshot), @"Exact read size");
    NSCAssert(strcmp(buffer, snapshot) == 0, @"Atomic roundtrip");
    NSString *file = [directory stringByAppendingPathComponent:@"session.json"];
    struct stat metadata;
    NSCAssert(stat(file.fileSystemRepresentation, &metadata) == 0 && (metadata.st_mode & 0777) == 0600, @"Session is private");
    NSCAssert(stat(directory.fileSystemRepresentation, &metadata) == 0 && (metadata.st_mode & 0777) == 0700, @"Directory is private");
    [[NSData data] writeToFile:file atomically:YES];
    NSCAssert(shelf_state_read(NULL, 0) == SIZE_MAX, @"An empty existing file is corrupt, not a new session");
    NSMutableData *oversized = [NSMutableData dataWithLength:8 * 1024 * 1024 + 1];
    [oversized writeToFile:file atomically:YES];
    NSCAssert(shelf_state_read(NULL, 0) == SIZE_MAX, @"Oversized state is preserved and rejected");
    puts("Storage roundtrip, permissions, empty-file and size-limit checks passed.");
  }
}
