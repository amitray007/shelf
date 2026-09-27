//! Derived disk cache. The validated session snapshot remains authoritative.
const std = @import("std");
const session = @import("session.zig");
extern fn shelf_link_cache_open() c_int;
extern fn shelf_link_cache_close() void;
extern fn shelf_link_cache_put(u64, [*:0]const u8, [*:0]const u8) c_int;
extern fn shelf_link_cache_read(u64, ?[*]u8, usize) usize;
extern fn shelf_link_cache_find_url([*:0]const u8) u64;
extern fn shelf_link_cache_set_active([*]const u64, usize) c_int;
extern fn shelf_link_cache_search([*:0]const u8, [*]u64, usize) usize;
extern fn shelf_link_cache_body(u64, [*:0]const u8) c_int;
extern fn getenv([*:0]const u8) ?[*:0]const u8;
var context: u8 = 0;
pub var enabled = false;
const allocator = std.heap.page_allocator;
fn put(_: *anyopaque, id: u64, url: []const u8, title: []const u8) !void {
    const url_z = try allocator.dupeZ(u8, url);
    defer allocator.free(url_z);
    const title_z = try allocator.dupeZ(u8, title);
    defer allocator.free(title_z);
    if (shelf_link_cache_put(id, url_z, title_z) == 0) return error.LocalCacheWriteFailed;
}
pub fn read(_: *anyopaque, alloc: std.mem.Allocator, id: u64) !session.Payload {
    const size = shelf_link_cache_read(id, null, 0);
    if (size == 0 or size == std.math.maxInt(usize) or size > 32768) return error.LocalCacheReadFailed;
    const json = try alloc.alloc(u8, size);
    defer alloc.free(json);
    if (shelf_link_cache_read(id, json.ptr, json.len) != size) return error.LocalCacheReadFailed;
    const parsed = try std.json.parseFromSlice(session.Payload, alloc, json, .{});
    defer parsed.deinit();
    const url = try alloc.dupe(u8, parsed.value.url);
    errdefer alloc.free(url);
    return .{ .url = url, .title = try alloc.dupe(u8, parsed.value.title) };
}
fn findUrl(_: *anyopaque, url: []const u8) !?u64 {
    const value = try allocator.dupeZ(u8, url);
    defer allocator.free(value);
    const id = shelf_link_cache_find_url(value);
    if (id == std.math.maxInt(u64)) return error.LocalCacheReadFailed;
    return if (id == 0) null else id;
}
pub fn start(model: *session.Session) !void {
    if (shelf_link_cache_open() == 0) return error.LocalCacheUnavailable;
    errdefer {
        enabled = false;
        model.payload_cache = null;
        shelf_link_cache_close();
    }
    try model.enablePayloadCache(.{ .context = &context, .put = put, .read = read, .find_url = findUrl });
    enabled = true;
    try sync(model);
}
pub fn stop() void {
    shelf_link_cache_close();
    enabled = false;
}
pub fn sync(model: *const session.Session) !void {
    if (!enabled) return;
    var ids: [session.max_links]u64 = undefined;
    for (model.links.items, 0..) |link, index| ids[index] = link.id;
    if (shelf_link_cache_set_active(&ids, model.links.items.len) == 0) return error.LocalCacheWriteFailed;
}
pub fn search(query: []const u8, ids: []u64) ![]const u64 {
    if (!enabled) return ids[0..0];
    const value = try allocator.dupeZ(u8, query);
    defer allocator.free(value);
    const count = shelf_link_cache_search(value, ids.ptr, ids.len);
    if (count > ids.len) return error.LocalCacheReadFailed;
    return ids[0..count];
}
pub fn body(id: u64, text: []const u8) !void {
    if (!enabled) return;
    const value = try allocator.dupeZ(u8, text);
    defer allocator.free(value);
    if (shelf_link_cache_body(id, value) == 0) return error.LocalCacheWriteFailed;
}
pub fn urlForClosed(alloc: std.mem.Allocator, link: session.Link) ![]const u8 {
    if (link.url.len > 0) return alloc.dupe(u8, link.url);
    const payload = try read(&context, alloc, link.id);
    alloc.free(payload.title);
    return payload.url;
}

pub fn trace(model: *const session.Session, first: usize, end: usize) void {
    if (getenv("SHELF_DESKTOP_CACHE_TRACE") == null) return;
    var resident: usize = 0;
    for (model.links.items) |link| if (link.url.len > 0) {
        resident += 1;
    };
    std.debug.print("shelf: local pages {d}..{d} resident={d}/{d}\n", .{ first, end, resident, model.links.items.len });
}
