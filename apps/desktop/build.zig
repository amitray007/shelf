const std = @import("std");
const native_sdk = @import("native_sdk");
pub fn build(b: *std.Build) void {
    const app = native_sdk.addAppArtifacts(b, b.dependency("native_sdk", .{}), .{ .name = "shelf-desktop", .manifest = "app.json" });
    app.exe.root_module.linkSystemLibrary("sqlite3", .{});
    const sdk_path = std.mem.trim(u8, b.run(&.{ "xcrun", "--show-sdk-path" }), "\r\n ");
    app.exe.root_module.addLibraryPath(.{ .cwd_relative = "/usr/lib" });
    app.exe.root_module.addCSourceFile(.{ .file = b.path("src/shell_macos.m"), .flags = &.{ "-fobjc-arc", "-isysroot", sdk_path, b.fmt("-I{s}/usr/include", .{sdk_path}) } });
    app.exe.root_module.addCSourceFile(.{ .file = b.path("src/macos.m"), .flags = &.{ "-fobjc-arc", "-isysroot", sdk_path, b.fmt("-I{s}/usr/include", .{sdk_path}) } });
    app.exe.root_module.addCSourceFile(.{ .file = b.path("src/storage.m"), .flags = &.{ "-fobjc-arc", "-isysroot", sdk_path, b.fmt("-I{s}/usr/include", .{sdk_path}) } });
    app.exe.root_module.addCSourceFile(.{ .file = b.path("src/link_cache.m"), .flags = &.{ "-fobjc-arc", "-isysroot", sdk_path, b.fmt("-I{s}/usr/include", .{sdk_path}) } });
}
