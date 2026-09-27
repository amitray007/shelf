const std = @import("std");
const t = @import("types.zig");
const cache = @import("payload_cache.zig");
fn matches(text: []const u8, query: []const u8) bool {
    if (query.len == 0) return true;
    if (query.len > text.len) return false;
    for (0..text.len - query.len + 1) |i| if (std.ascii.eqlIgnoreCase(text[i..][0..query.len], query)) return true;
    return false;
}
pub fn choices(model: *const t.Model, allocator: std.mem.Allocator) []const t.Choice {
    var items: std.ArrayList(t.Choice) = .empty;
    const query = std.mem.trim(u8, model.query(), " \t\r\n");
    switch (model.mode) {
        .create, .rename => {
            if (query.len > 0) items.append(allocator, .{ .label = query, .detail = if (model.mode == .create) "Create section" else "Rename section", .action = .submit }) catch {};
        },
        .move, .close_section => {
            if (model.mode == .move and matches("Inbox", query)) items.append(allocator, .{ .label = "Inbox", .detail = "Move here", .action = .{ .choose_section = 0 } }) catch {};
            for (model.session.sections.items) |section| {
                if (matches(section.name, query)) items.append(allocator, .{ .label = section.name, .detail = if (model.mode == .move) "Move here" else "Close section and its links", .action = if (model.mode == .move) .{ .choose_section = section.id } else .{ .close_section = section.id } }) catch {};
            }
        },
        .search => {
            if (std.mem.startsWith(u8, query, "https://") or std.mem.startsWith(u8, query, "http://")) {
                items.append(allocator, .{ .label = "Open link", .detail = query, .icon = "external-link", .action = .submit }) catch {};
            }
            if (cache.enabled) {
                for (model.search_ids[0..model.search_count]) |id| {
                    const link = model.session.getLink(id) orelse continue;
                    items.append(allocator, .{ .label = link.title, .detail = (model.session.getSection(link.section_id) orelse unreachable).name, .icon = if (link.parent_id == null) "file-text" else "external-link", .action = .{ .select = link.id } }) catch {};
                }
            } else {
                for (model.session.links.items) |link| {
                    if (matches(link.title, query) or matches(link.url, query)) items.append(allocator, .{ .label = link.title, .detail = (model.session.getSection(link.section_id) orelse unreachable).name, .icon = if (link.parent_id == null) "file-text" else "external-link", .action = .{ .select = link.id } }) catch {};
                }
            }
            const commands = [_]t.Choice{
                .{ .label = "New section", .detail = "Keep related links together", .icon = "plus", .action = .create_section },
                .{ .label = "Reopen closed link or section", .detail = "⌘⇧T", .icon = "clock", .action = .reopen },
                .{ .label = "Shelf Home", .icon = "app:shelf", .action = .home },
                .{ .label = "Toggle full screen", .icon = "app:fullscreen", .action = .fullscreen },
                .{ .label = "Toggle sidebar", .detail = "⌘\\", .icon = "panel-left", .action = .sidebar },
            };
            for (commands) |choice| if (matches(choice.label, query)) {
                items.append(allocator, choice) catch {};
            };
            if (model.session.selected) |id| {
                const selected = [_]t.Choice{
                    .{ .label = "Move link to section", .detail = "⌘⇧M", .action = .{ .move = id } },
                    .{ .label = "Close current link", .detail = "⌘W", .action = .close_active },
                    .{ .label = "Reload page", .detail = "⌘R", .action = .reload },
                    .{ .label = "Copy link", .action = .copy_url },
                    .{ .label = "Go back", .detail = "⌘[", .action = .back },
                    .{ .label = "Go forward", .detail = "⌘]", .action = .forward },
                };
                for (selected) |choice| if (matches(choice.label, query)) {
                    items.append(allocator, choice) catch {};
                };
            }
            for (model.session.sections.items) |section| {
                const rename = std.fmt.allocPrint(allocator, "Rename {s}", .{section.name}) catch continue;
                if (matches(rename, query)) items.append(allocator, .{ .label = rename, .action = .{ .rename = section.id } }) catch {};
                const close = std.fmt.allocPrint(allocator, "Close {s}", .{section.name}) catch continue;
                if (matches(close, query)) items.append(allocator, .{ .label = close, .detail = "Close section and its links", .action = .{ .close_section = section.id } }) catch {};
            }
        },
    }
    return items.items;
}
