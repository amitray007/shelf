//! The approved Shelf shell, shared by the live workspace.
const std = @import("std");
const sdk = @import("native_sdk");
const types = @import("types.zig");
const session = @import("session.zig");
const commands = @import("commands.zig");
const Model = types.Model;
const App = types.App;
const Node = App.Ui.Node;
const brand = sdk.canvas.svg_icon.parseComptime(@embedFile("brand.svg"));
const wordmark = sdk.canvas.svg_icon.parseComptime(@embedFile("wordmark.svg"));
const fullscreen_icon = sdk.canvas.svg_icon.parseComptime(@embedFile("fullscreen.svg"));
const archive_icon = sdk.canvas.svg_icon.parseComptime(@embedFile("archive.svg"));
const app_icons = [_]sdk.canvas.icons.Entry{ .{ .name = "archive", .icon = &archive_icon }, .{ .name = "shelf", .icon = &brand }, .{ .name = "wordmark", .icon = &wordmark }, .{ .name = "fullscreen", .icon = &fullscreen_icon } };
const clear = sdk.canvas.Color.rgba8(0, 0, 0, 0);
const background = sdk.canvas.Color.rgb8(17, 17, 17);
const content = sdk.canvas.Color.rgb8(8, 8, 8);
const primary = sdk.canvas.Color.rgb8(237, 237, 237);
const muted = sdk.canvas.Color.rgb8(160, 160, 160);
const border = sdk.canvas.Color.rgb8(46, 46, 46);
const sidebar_width: f32 = 256;
pub const sidebar_scroll_id = sdk.canvas.globalWidgetId(.scroll_view, .{ .str = "shelf-sidebar" });
pub const scroll_refill_distance: f32 = 204;
const scroll_buffer: f32 = 408;
pub fn syncScroll(model: *Model, layout: sdk.canvas.WidgetLayoutTree) void {
    if (layout.findById(sidebar_scroll_id)) |node| {
        // dispatch and rebuild both sync. Consume a native offset once so the
        // second sync cannot undo a keyboard command's requested scroll.
        if (node.widget.value != model.observed_scroll) {
            model.scroll = node.widget.value;
            model.observed_scroll = node.widget.value;
        }
    }
}
const header_height: f32 = 48;
const sidebar_inset: f32 = 16;
const identity_height: f32 = 40;
const group_gap: f32 = 12;
pub fn tokens() sdk.canvas.DesignTokens {
    var value = sdk.canvas.DesignTokens.theme(.{ .color_scheme = .dark });
    value.colors.scrim = sdk.canvas.Color.rgba8(0, 0, 0, 136);
    value.blur.scrim = 0;
    value.shadow.sm = .{ .y = 0, .blur = 0, .spread = 0 };
    value.colors.background = content;
    value.colors.surface = background;
    value.colors.surface_subtle = sdk.canvas.Color.rgb8(31, 31, 31);
    value.colors.surface_pressed = sdk.canvas.Color.rgb8(41, 41, 41);
    value.colors.text = primary;
    value.colors.text_muted = muted;
    value.colors.border = border;
    value.colors.focus_ring = sdk.canvas.Color.rgb8(80, 168, 255);
    return value;
}
fn label(ui: *App.Ui, text: []const u8, size: f32, color: sdk.canvas.Color) Node {
    return ui.paragraph(.{ .wrap = false, .style = .{ .foreground = color } }, &.{.{ .text = text, .scale = size / 14, .weight = .regular }});
}
fn toggle(ui: *App.Ui, expanded: bool) Node {
    return ui.el(.icon_button, .{ .icon = "panel-left", .width = 32, .height = 32, .variant = .ghost, .on_press = .sidebar, .style = .{ .foreground = muted, .radius = 6 }, .semantics = .{ .label = if (expanded) "Hide sidebar · Command backslash" else "Show sidebar · Command backslash" } }, .{});
}
// Real buttons above custom content keep the whole visual target clickable.
fn pressable(ui: *App.Ui, options: App.Ui.ElementOptions, child: Node) Node {
    var container = options;
    container.on_press = null;
    container.semantics = .{};
    return ui.panel(container, .{
        child,
        ui.button(.{ .grow = 1, .width = options.width, .height = options.height, .variant = .ghost, .on_press = options.on_press, .on_drag = options.on_drag, .context_menu = options.context_menu, .style = .{ .background = clear, .border = clear, .foreground = clear, .radius = options.style.radius }, .semantics = options.semantics }, ""),
    });
}
fn commandTrigger(ui: *App.Ui) Node {
    return pressable(
        ui,
        .{ .width = 61, .height = 32, .padding = 0, .on_press = .command, .style = .{ .foreground = muted, .background = clear, .border = clear, .radius = 6, .stroke_width = 0 }, .semantics = .{ .role = .button, .label = "Search links and commands · Command K" } },
        ui.row(.{ .gap = 8, .padding = 8, .cross = .center }, .{
            ui.icon(.{ .width = 14, .height = 14, .style = .{ .foreground = muted } }, "search"),
            label(ui, "⌘ K", 12, muted),
        }),
    );
}
fn header(ui: *App.Ui, model: *const Model) Node {
    const top = @max(0, model.controls_center_y - 16);
    return ui.column(.{ .height = header_height, .gap = 0, .window_drag = true }, .{
        ui.el(.stack, .{ .height = top }, .{}),
        ui.row(.{ .height = 32, .gap = 0, .cross = .center }, .{
            ui.el(.stack, .{ .width = if (model.session.sidebar_visible) sidebar_width - sidebar_inset - 32 else model.controls_leading }, .{}),
            toggle(ui, model.session.sidebar_visible),
            if (!model.session.sidebar_visible) commandTrigger(ui) else ui.el(.stack, .{ .width = 0 }, .{}),
        }),
    });
}
fn identity(ui: *App.Ui) Node {
    return ui.row(.{ .height = identity_height, .gap = 0, .cross = .center }, .{
        ui.el(.stack, .{ .width = sidebar_inset }, .{}),
        pressable(
            ui,
            .{ .width = 64, .height = 32, .padding = 0, .on_press = .home, .style = .{ .background = clear, .border = clear, .stroke_width = 0, .radius = 0, .quiet_hover = true }, .semantics = .{ .role = .button, .label = "Shelf Home" } },
            ui.row(.{ .gap = 8, .cross = .center }, .{
                ui.appIcon(.{ .width = 18, .height = 18, .style = .{ .foreground = primary } }, "app:shelf"),
                ui.appIcon(.{ .width = 38, .height = 24, .style = .{ .foreground = primary } }, "app:wordmark"),
            }),
        ),
        ui.spacer(1),
        commandTrigger(ui),
        ui.el(.stack, .{ .width = sidebar_inset }, .{}),
    });
}
pub fn view(ui: *App.Ui, model: *const Model) Node {
    return ui.el(.stack, .{ .grow = 1 }, .{
        ui.row(.{ .grow = 1, .gap = 0 }, .{
            if (model.session.sidebar_visible) ui.panel(.{ .width = sidebar_width, .style = .{ .background = background, .radius = 0, .stroke_width = 0 } }, .{
                ui.column(.{ .grow = 1, .gap = 0 }, .{ header(ui, model), identity(ui), ui.el(.stack, .{ .height = group_gap }, .{}), sidebarBody(ui, model) }),
            }) else ui.el(.stack, .{ .width = 0 }, .{}),
            if (model.session.sidebar_visible) ui.panel(.{ .width = 1, .style = .{ .background = border, .radius = 0, .stroke_width = 0 } }, .{}) else ui.el(.stack, .{}, .{}),
            ui.panel(.{ .grow = 1, .style = .{ .background = content, .radius = 0, .stroke_width = 0 } }, .{
                ui.column(.{ .grow = 1, .gap = 0 }, .{ if (!model.session.sidebar_visible) header(ui, model) else ui.el(.stack, .{}, .{}), if (model.error_page) errorContent(ui) else if (model.loading and model.session.selected != null) loadingContent(ui) else if (model.session.selected == null) homeContent(ui, model) else ui.spacer(1) }),
            }),
        }),
        if (model.palette) ui.panel(.{ .grow = 1, .on_press = .dismiss, .style = .{ .background = sdk.canvas.Color.rgba8(0, 0, 0, 136), .border = clear, .radius = 0 } }, .{}) else ui.el(.stack, .{}, .{}),
        if (model.palette) paletteView(ui, model) else ui.el(.stack, .{}, .{}),
    });
}
fn paletteView(ui: *App.Ui, model: *const Model) Node {
    const all_items = commands.choices(model, ui.arena);
    const visible_rows: usize = @intFromFloat(@max(1, @min(8, @floor((model.viewport.height - 208) / 44))));
    const first = if (model.cursor >= visible_rows) model.cursor - visible_rows + 1 else 0;
    const items = all_items[@min(first, all_items.len)..@min(first + visible_rows, all_items.len)];
    const rows = ui.arena.alloc(Node, items.len) catch return ui.column(.{}, .{});
    for (items, 0..) |item, index| {
        const icon = ui.el(.icon, .{ .icon = if (item.icon.len == 0) "folder" else item.icon, .width = 16, .height = 16, .style = .{ .foreground = muted } }, .{});
        rows[index] = pressable(
            ui,
            .{ .key = .{ .int = index }, .height = 44, .padding = 0, .on_press = .{ .choice = first + index }, .selected = first + index == model.cursor, .style = .{ .background = if (first + index == model.cursor) sdk.canvas.Color.rgb8(41, 41, 41) else background, .border = if (first + index == model.cursor) sdk.canvas.Color.rgb8(62, 62, 62) else background, .stroke_width = 1, .radius = 6 }, .semantics = .{ .role = .button, .label = item.label } },
            ui.row(.{ .padding = 12, .gap = 12, .cross = .center }, .{ icon, ui.paragraph(.{ .grow = 1, .wrap = false, .style = .{ .foreground = primary } }, &.{.{ .text = item.label, .weight = .regular }}), label(ui, if (item.detail.len < 32) item.detail else "Enter ↵", 12, muted) }),
        );
    }
    return ui.el(.popover, .{ .frame = .{ .x = (model.viewport.width - 560) / 2, .y = 96 }, .width = 560, .height = @as(f32, @floatFromInt(@max(items.len, 1))) * 44 + 108, .padding = 0, .on_dismiss = .dismiss, .style = .{ .background = background, .border = sdk.canvas.Color.rgb8(69, 69, 69), .stroke_width = 1, .radius = 12 }, .semantics = .{ .label = "Search links and commands" } }, .{
        ui.column(.{ .grow = 1, .gap = 0 }, .{
            ui.row(.{ .height = 64, .padding = 16, .gap = 12, .cross = .center }, .{
                ui.icon(.{ .width = 20, .height = 20, .style = .{ .foreground = muted } }, "search"),
                ui.textField(.{ .key = .{ .int = 9000 + model.palette_generation }, .grow = 1, .height = 32, .padding = 0, .text = model.query(), .placeholder = switch (model.mode) {
                    .search => "Search links or paste a URL…",
                    .create => "Name the new section…",
                    .rename => "Rename section…",
                    .move => "Move link to a section…",
                    .close_section => "Choose a section to close…",
                }, .autofocus = true, .on_input = App.Ui.inputMsg(.query), .on_submit = .submit, .style = .{ .background = background, .foreground = if (model.query_len == 0) muted else primary, .border = clear, .focus_ring = clear, .stroke_width = 0, .radius = 0 }, .semantics = .{ .label = "Search links and commands" } }),
                pressable(ui, .{ .width = 28, .height = 20, .on_press = .dismiss, .style = .{ .background = background, .border = border, .radius = 4 }, .semantics = .{ .role = .button, .label = "Dismiss command menu · Escape" } }, ui.row(.{ .main = .center, .cross = .center }, .{label(ui, "esc", 10, muted)})),
            }),
            ui.panel(.{ .height = 1, .style = .{ .background = border, .stroke_width = 0, .radius = 0 } }, .{}),
            ui.row(.{ .height = 28, .padding = 16, .cross = .center }, .{label(ui, if (model.status_len > 0) model.status() else switch (model.mode) {
                .search => "Links and commands",
                .create => "New section · Enter to create",
                .rename => "Rename section · Enter to save",
                .move => "Move to",
                .close_section => "Close section",
            }, 12, muted)}),
            ui.column(.{ .height = @as(f32, @floatFromInt(items.len)) * 44 + 16, .padding = 8, .gap = 0 }, rows),
            if (items.len == 0) ui.row(.{ .height = 44, .padding = 16 }, .{label(ui, if (model.mode == .create or model.mode == .rename) "Type a name, then press Enter." else "No matches. Try a title or paste a URL.", 14, muted)}) else ui.el(.stack, .{}, .{}),
        }),
    });
}

pub fn registerIcons() void {
    sdk.canvas.icons.registerAppIcons(&app_icons);
}

fn homeContent(ui: *App.Ui, model: *const Model) Node {
    return ui.column(.{ .grow = 1, .cross = .center, .main = .center, .gap = 12 }, .{
        label(ui, "Experimental beta · Development experiments only", 12, muted),
        label(ui, "Do not use for daily work or production.", 12, muted),
        ui.appIcon(.{ .width = 28, .height = 28, .style = .{ .foreground = muted } }, "app:shelf"),
        label(ui, if (model.session.links.items.len == 0) "A place for your links" else "Pick up where you left off", 18, primary),
        label(ui, if (model.session.links.items.len == 0) "Open a Shelf link. It will land in your Inbox." else "Choose a link in the sidebar, or find it with ⌘K.", 13, muted),
        pressable(ui, .{ .width = 176, .height = 34, .on_press = .focus_command, .style = .{ .background = background, .border = border, .radius = 6 }, .semantics = .{ .label = "Open a link · Command K", .role = .button } }, ui.row(.{ .cross = .center, .main = .center }, .{label(ui, "Open a link    ⌘ K", 13, primary)})),
    });
}
fn loadingContent(ui: *App.Ui) Node {
    return ui.column(.{ .grow = 1, .cross = .center, .main = .center, .gap = 14 }, .{
        ui.el(.spinner, .{ .width = 22, .height = 22, .style = .{ .foreground = muted }, .semantics = .{ .label = "Loading page" } }, .{}),
        label(ui, "Loading page…", 14, muted),
    });
}
fn errorContent(ui: *App.Ui) Node {
    return ui.column(.{ .grow = 1, .cross = .center, .main = .center, .gap = 12 }, .{
        label(ui, "This page could not load", 18, primary),
        label(ui, "Check your connection, then try again.", 13, muted),
        ui.button(.{ .on_press = .reload, .variant = .ghost }, "Try again  ⌘R"),
    });
}
const Flat = struct { kind: enum { heading, link, empty, gap }, section: u64 = 0, link: ?session.Link = null };
fn entries(model: *const Model, allocator: std.mem.Allocator) []const Flat {
    var result: std.ArrayList(Flat) = .empty;
    for (0..model.session.sections.items.len + 1) |i| {
        const section = if (i == 0) model.session.getSection(0).? else model.session.sections.items[i - 1];
        if (i > 0) result.append(allocator, .{ .kind = .gap }) catch {};
        result.append(allocator, .{ .kind = .heading, .section = section.id }) catch {};
        if (section.collapsed) continue;
        var count: usize = 0;
        for (model.session.links.items) |link| {
            if (link.section_id != section.id) continue;
            count += 1;
            result.append(allocator, .{ .kind = .link, .section = section.id, .link = link }) catch {};
        }
        if (count == 0) result.append(allocator, .{ .kind = .empty, .section = section.id }) catch {};
    }
    return result.items;
}
fn extent(item: Flat) f32 {
    return switch (item.kind) {
        .heading => types.section_height,
        .link => types.row_height,
        .empty => if (item.section == 0) 68 else 34,
        .gap => 16,
    };
}
pub const PageRange = struct { first: usize, end: usize, count: usize };
// Disk pages are independent of pixel scrolling. Keep neighboring 64-row
// pages, while the renderer only mounts the much smaller visible window.
pub fn pageLinkIds(model: *const Model, ids: []u64) PageRange {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const items = entries(model, arena.allocator());
    const height = @max(100, model.viewport.height - types.header_height);
    var start: usize = 0;
    var y: f32 = 0;
    while (start < items.len and y + extent(items[start]) < model.window_scroll - scroll_buffer) : (start += 1) y += extent(items[start]);
    var end = start;
    while (end < items.len and y < model.window_scroll + height + scroll_buffer) : (end += 1) y += extent(items[end]);
    const first_page = (start / 64 -| 1) * 64;
    const page_end = @min(items.len, ((end + 63) / 64 + 1) * 64);
    var count: usize = 0;
    for (items[first_page..page_end]) |item| {
        if (item.link) |link| {
            if (count == ids.len) break;
            ids[count] = link.id;
            count += 1;
        }
    }
    return .{ .first = first_page, .end = page_end, .count = count };
}
fn sidebarBody(ui: *App.Ui, model: *const Model) Node {
    const items = entries(model, ui.arena);
    // Mount only visible rows plus a small margin. Large sessions keep the same
    // scroll geometry without rebuilding thousands of widgets on every hover.
    const visible_height = @max(100, model.viewport.height - types.header_height);
    var start: usize = 0;
    var end: usize = items.len;
    var top: f32 = 0;
    while (start < items.len and top + extent(items[start]) < model.window_scroll - scroll_buffer) : (start += 1) top += extent(items[start]);
    var bottom = top;
    end = start;
    while (end < items.len and bottom < model.window_scroll + visible_height + scroll_buffer) : (end += 1) bottom += extent(items[end]);
    var total = bottom;
    for (items[end..]) |item| total += extent(item);
    const nodes = ui.arena.alloc(Node, end - start + 2) catch return ui.column(.{}, .{});
    nodes[0] = ui.el(.stack, .{ .height = top }, .{});
    nodes[nodes.len - 1] = ui.el(.stack, .{ .height = total - bottom }, .{});
    for (items[start..end], 1..) |item, index| {
        nodes[index] = switch (item.kind) {
            .heading => sectionHeader(ui, model, model.session.getSection(item.section).?),
            .link => linkRow(ui, model, item.link.?),
            .gap => ui.column(.{ .height = 16, .padding = 8 }, .{ui.panel(.{ .height = 1, .style = .{ .background = border, .border = clear, .radius = 0 } }, .{})}),
            .empty => if (item.section == 0) ui.column(.{ .height = 68, .padding = 8, .gap = 4 }, .{
                label(ui, "All clear", 12, sdk.canvas.Color.rgb8(186, 186, 186)),
                label(ui, "New links appear here.", 12, sdk.canvas.Color.rgb8(136, 136, 136)),
                label(ui, "Paste a link with ⌘K.", 12, sdk.canvas.Color.rgb8(136, 136, 136)),
            }) else ui.row(.{ .height = 34, .padding = 8, .cross = .center }, .{label(ui, "Drop links here", 12, sdk.canvas.Color.rgb8(136, 136, 136))}),
        };
    }
    return ui.scroll(.{ .global_key = .{ .str = "shelf-sidebar" }, .grow = 1, .value = model.scroll }, .{ui.column(.{ .padding = 8, .gap = 0 }, nodes)});
}
fn sectionHeader(ui: *App.Ui, model: *const Model, section: session.Section) Node {
    const hover = model.hover_section == section.id;
    const target = model.drag_id != null and (if (model.drag_section) model.drop_before == section.id else model.drop_section == section.id);
    return ui.row(.{ .global_key = .{ .int = 20000 + section.id }, .height = 28, .gap = 0, .cross = .center, .on_hover_enter = .{ .hover_section = section.id }, .on_hover_leave = .{ .hover_section = null }, .style = .{ .background = if (target) sdk.canvas.Color.rgb8(18, 33, 50) else clear, .border = clear, .radius = 6 } }, .{
        pressable(ui, .{ .grow = 1, .height = 28, .on_press = .{ .toggle_section = section.id }, .on_drag = if (section.id == 0) null else .{ .drag_section = .{ .sourceId = section.id } }, .context_menu = if (section.id == 0) &.{} else &.{ .{ .label = "Rename section", .msg = .{ .rename = section.id } }, .{ .label = "Close section", .msg = .{ .close_section = section.id } } }, .style = .{ .background = clear, .border = clear, .radius = 6 }, .semantics = .{ .role = .button, .label = if (section.id == 0) (if (section.collapsed) "Expand Inbox" else "Collapse Inbox") else section.name } }, ui.row(.{ .padding = 8, .gap = 8, .cross = .center }, .{
            ui.paragraph(.{ .grow = 1, .wrap = false, .style = .{ .foreground = if (section.id == 0) sdk.canvas.Color.rgb8(212, 212, 212) else muted } }, &.{.{ .text = section.name, .scale = (if (section.id == 0) @as(f32, 13) else 12) / 14, .weight = .medium }}),
            ui.el(.icon, .{ .icon = if (section.collapsed) "chevron-right" else "chevron-down", .width = 12, .height = 12, .style = .{ .foreground = muted } }, .{}),
        })),
        if (section.id != 0 and hover) ui.el(.icon_button, .{ .icon = "app:archive", .size = .sm, .width = 24, .height = 24, .variant = .ghost, .on_press = .{ .close_section = section.id }, .semantics = .{ .label = "Close section" } }, .{}) else ui.el(.stack, .{ .width = 0 }, .{}),
    });
}
fn linkRow(ui: *App.Ui, model: *const Model, link: session.Link) Node {
    const selected = model.session.selected == link.id;
    const hover = model.hover == link.id;
    const target = model.drag_id != null and !model.drag_section and model.drop_before == link.id;
    return ui.row(.{ .global_key = .{ .int = link.id }, .height = 34, .gap = 0, .cross = .center, .on_hover_enter = .{ .hover = link.id }, .on_hover_leave = .{ .hover = null }, .style = .{ .background = if (selected) sdk.canvas.Color.rgb8(36, 36, 36) else if (hover) sdk.canvas.Color.rgb8(27, 27, 27) else clear, .border = if (target) sdk.canvas.Color.rgb8(80, 168, 255) else clear, .stroke_width = 1, .radius = 6 } }, .{
        pressable(ui, .{ .width = 208, .height = 34, .on_press = .{ .select = link.id }, .on_drag = .{ .drag_link = .{ .sourceId = link.id } }, .context_menu = &.{ .{ .label = "Move to section…", .msg = .{ .move = link.id } }, .{ .label = "Copy link", .msg = .{ .copy_link = link.id } }, .{ .label = "Close link", .msg = .{ .close_link = link.id } } }, .style = .{ .background = clear, .border = clear, .radius = 6 }, .semantics = .{ .role = .button, .label = link.title } }, ui.row(.{ .padding = 8, .gap = 8, .cross = .center }, .{
            if (selected and model.loading) ui.el(.spinner, .{ .width = 15, .height = 15, .style = .{ .foreground = muted }, .semantics = .{ .label = "Loading page" } }, .{}) else ui.el(.icon, .{ .icon = if (link.parent_id == null) "file-text" else "external-link", .width = 15, .height = 15, .style = .{ .foreground = muted } }, .{}),
            ui.paragraph(.{ .width = 169, .wrap = false, .overflow = .ellipsis, .style = .{ .foreground = if (selected) primary else sdk.canvas.Color.rgb8(186, 186, 186) } }, &.{.{ .text = link.title, .scale = 13.0 / 14.0, .weight = if (selected) .medium else .regular }}),
        })),
        if (hover or selected) ui.el(.icon_button, .{ .icon = "app:archive", .size = .sm, .width = 28, .height = 28, .variant = .ghost, .on_press = .{ .close_link = link.id }, .style = .{ .foreground = muted, .radius = 5 }, .semantics = .{ .label = "Close link" } }, .{}) else ui.row(.{ .width = 28, .height = 28, .main = .center, .cross = .center }, .{
            if (link.unread) ui.panel(.{ .width = 5, .height = 5, .style = .{ .background = sdk.canvas.Color.rgb8(80, 168, 255), .border = clear, .radius = 3 }, .semantics = .{ .label = "Unread" } }, .{}) else ui.el(.stack, .{}, .{}),
        }),
        ui.el(.stack, .{ .width = 4 }, .{}),
    });
}
pub fn updateDrop(model: *Model, value: types.Drag, is_section: bool) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const items = entries(model, arena.allocator());
    const y = value.y - types.header_height - 8 + model.scroll;
    var cursor: f32 = 0;
    model.drop_section = 0;
    model.drop_before = null;
    for (items) |item| {
        const height = extent(item);
        if (is_section) {
            if (item.kind == .heading and item.section != 0 and y < cursor + height / 2) {
                model.drop_before = item.section;
                break;
            }
        } else {
            if (item.kind == .heading) model.drop_section = item.section;
            if (y < cursor + (if (item.kind == .link) height / 2 else height)) {
                if (item.kind == .link) model.drop_before = item.link.?.id;
                break;
            }
        }
        cursor += height;
    }
}

pub fn revealLink(model: *Model, id: u64) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const items = entries(model, arena.allocator());
    const visible_height = @max(100, model.viewport.height - types.header_height - 16);
    var top: f32 = 0;
    for (items) |item| {
        const height = extent(item);
        if (item.kind == .link and item.link.?.id == id) {
            if (top < model.scroll) model.scroll = top;
            if (top + height > model.scroll + visible_height) model.scroll = top + height - visible_height;
            return;
        }
        top += height;
    }
}
