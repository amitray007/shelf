const std = @import("std");
const sdk = @import("native_sdk");
pub const panic = std.debug.FullPanic(sdk.debug.capturePanic);
pub fn main(init: std.process.Init) !void {
    try @import("workspace.zig").main(init);
}
