const std = @import("std");
const runner = @import("runner");
const sdk = @import("native_sdk");
const t = @import("types.zig");
const ui = @import("ui.zig");
const commands = @import("commands.zig");
const cache = @import("payload_cache.zig");
const App = t.App;
const Model = t.Model;
const Msg = t.Msg;
const allocator = std.heap.page_allocator;
const viewer_enabled = true;
var refresh_pending = false;
var host_needs_save = false;
extern fn shelf_bundle_icon_path() [*:0]const u8;
extern fn shelf_shell_keys_install(?*const fn (u8) callconv(.c) void) void;
extern fn shelf_shell_palette_open(c_int) void;
extern fn shelf_shell_fullscreen() void;
fn paletteKey(key: u8) callconv(.c) void {
    const app = live_app orelse return;
    const runtime = live_runtime orelse return;
    if (app.model.palette) app.dispatch(runtime, 1, if (key == 1) .next_result else .previous_result) catch {};
}
fn chromeChanged(chrome: sdk.platform.WindowChrome) ?Msg {
    return .{ .chrome = chrome };
}

pub const panic = std.debug.FullPanic(sdk.debug.capturePanic);
extern fn shelf_host_install() void;
extern fn shelf_host_set_callback(callback: ?*const fn () callconv(.c) void) void;
extern fn shelf_host_update(url: [*:0]const u8, sidebar_width: f64, hidden: c_int) void;
extern fn shelf_host_poll(json: [*]u8, capacity: usize) usize;
extern fn shelf_host_close(url: [*:0]const u8) void;
extern fn shelf_host_reload() void;
extern fn shelf_host_back() void;
extern fn shelf_host_forward() void;
extern fn shelf_host_focus() void;
extern fn shelf_host_copy(text: [*:0]const u8) void;
extern fn shelf_host_palette() void;
extern fn shelf_host_shutdown() void;
extern fn shelf_state_read(buffer: ?[*]u8, capacity: usize) usize;
extern fn shelf_state_write(buffer: [*]const u8, length: usize) c_int;
const views = [_]sdk.ShellView{.{ .label = "canvas", .kind = .gpu_surface, .fill = true, .gpu_backend = .metal }};
const windows = [_]sdk.ShellWindow{.{ .label = "main", .title = "Shelf", .width = 1200, .height = 800, .min_width = 720, .min_height = 480, .titlebar = .hidden_inset_tall, .views = &views }};
var event_buffer: [131072]u8 = undefined;
var live_app: ?*App = null;
var live_runtime: ?*sdk.Runtime = null;
var callback_ready = false;
fn start(_: *anyopaque, runtime: *sdk.Runtime) !void {
    live_runtime = runtime;
}
fn hostEvent() callconv(.c) void {
    const app = live_app orelse return;
    const runtime = live_runtime orelse return;
    while (true) {
        const n = shelf_host_poll(&event_buffer, event_buffer.len);
        if (n == 0) break;
        app.dispatch(runtime, 1, .{ .host_event = n }) catch |err| status(&app.model, @errorName(err));
    }
}
fn status(model: *Model, text: []const u8) void {
    model.palette = true;
    model.status_len = @min(text.len, model.status_buffer.len);
    @memcpy(model.status_buffer[0..model.status_len], text[0..model.status_len]);
}
fn save(model: *Model) void {
    if (model.persistence_blocked) return;
    const json = model.session.encodeJson(allocator) catch {
        status(model, "Could not save this session.");
        return;
    };
    defer allocator.free(json);
    if (shelf_state_write(json.ptr, json.len) == 0) status(model, "Could not save this session. Your open links are still available here.");
}
fn restore(model: *Model) void {
    const size = shelf_state_read(null, 0);
    if (size == 0) return;
    if (size == std.math.maxInt(usize)) {
        model.persistence_blocked = true;
        status(model, "The saved session could not be read. The original file has been preserved.");
        return;
    }
    const bytes = allocator.alloc(u8, size) catch return;
    defer allocator.free(bytes);
    if (shelf_state_read(bytes.ptr, bytes.len) != size) {
        model.persistence_blocked = true;
        status(model, "The saved session changed while opening. Restart Shelf to try again.");
        return;
    }
    const session = t.Session.decodeJson(allocator, bytes) catch {
        model.persistence_blocked = true;
        status(model, "The saved session is invalid. The original file has been preserved.");
        return;
    };
    model.session.deinit();
    model.session = session;
}
fn palette(model: *Model, mode: t.Mode, target: ?u64) void {
    model.palette = true;
    model.palette_generation += 1;
    model.mode = mode;
    model.status_len = 0;
    model.target = target;
    model.query_len = 0;
    model.query_selection = .{};
    model.query_composition = null;
    model.cursor = 0;
}
fn reveal(model: *Model, id: u64) void {
    const link = model.session.getLink(id) orelse return;
    for (model.session.sections.items) |*section| if (section.id == link.section_id) {
        section.collapsed = false;
    };
    if (link.section_id == 0) model.session.inbox_collapsed = false;
    ui.revealLink(model, id);
    model.loading = false;
    model.error_page = false;
    model.status_len = 0;
    model.palette = false;
}
fn openURL(model: *Model, raw_url: []const u8, parent: ?u64) !void {
    const url = std.mem.trim(u8, raw_url, " \t\r\n");
    const parsed = std.Uri.parse(url) catch return error.InvalidUrl;
    const host = parsed.host orelse return error.InvalidUrl;
    const label = switch (host) {
        .raw => |s| s,
        .percent_encoded => |s| s,
    };
    const previous_id = model.session.selected;
    const was_loading = model.loading;
    const was_error = model.error_page;
    const id = try model.session.open(url, label, parent);
    reveal(model, id);
    if (parent == null and model.session.getLink(id).?.section_id == 0) model.scroll = 0;
    model.session.sidebar_visible = true;
    if (previous_id == id) {
        model.loading = was_loading;
        if (was_error) {
            model.loading = true;
            shelf_host_reload();
        }
        return;
    }
    model.loading = true;
    for (model.session.links.items) |*link| if (link.id == id) {
        link.unread = true;
    };
}
fn releaseClosedViews(model: *Model) void {
    if (model.session.closed.items.len == 0) return;
    const batch = model.session.closed.items[model.session.closed.items.len - 1];
    for (batch.links.items) |link| {
        const raw = cache.urlForClosed(allocator, link) catch continue;
        defer allocator.free(raw);
        const url = allocator.dupeZ(u8, raw) catch continue;
        defer allocator.free(url);
        shelf_host_close(url);
    }
}
fn closeLink(model: *Model, id: u64) !void {
    const next = if (model.session.selected == id) model.session.cycle(1) else model.session.selected;
    try model.session.closeLink(id);
    releaseClosedViews(model);
    if (next) |next_id| {
        if (model.session.getLink(next_id) != null) try model.session.select(next_id);
    }
    model.palette = false;
    model.error_page = false;
    model.status_len = 0;
}
fn applyQuery(model: *Model, event: sdk.canvas.TextInputEvent) !void {
    var scratch: [4096]u8 = undefined;
    const state = sdk.canvas.TextEditState{ .text = model.query(), .selection = model.query_selection, .composition = model.query_composition };
    const next = try state.apply(event, &scratch);
    model.query_len = next.text.len;
    @memcpy(model.query_buffer[0..next.text.len], next.text);
    model.query_selection = next.selection;
    model.query_composition = next.composition;
    model.cursor = 0;
}
fn submit(model: *Model) !void {
    const query = std.mem.trim(u8, model.query(), " \t\r\n");
    switch (model.mode) {
        .create => {
            _ = try model.session.createSection(query);
            model.palette = false;
        },
        .rename => {
            try model.session.renameSection(model.target orelse return, query);
            model.palette = false;
        },
        .search => {
            if (std.mem.startsWith(u8, query, "https://") or std.mem.startsWith(u8, query, "http://")) try openURL(model, query, null) else try choose(model, model.cursor);
        },
        else => try choose(model, model.cursor),
    }
}
fn choose(model: *Model, index: usize) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const choices = commands.choices(model, arena.allocator());
    if (index >= choices.len) return;
    try perform(model, choices[index].action);
}
fn eventString(value: std.json.Value, key: []const u8) []const u8 {
    if (value != .object) return "";
    const field = value.object.get(key) orelse return "";
    return if (field == .string) field.string else "";
}
fn handleHost(model: *Model, bytes: []const u8) !void {
    host_needs_save = false;
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    const value = parsed.value;
    const kind = eventString(value, "kind");
    const url = eventString(value, "url");
    const source = eventString(value, "source");
    if (!std.mem.eql(u8, kind, "open") and source.len > 0) {
        const selected = model.session.getLink(model.session.selected orelse return) orelse return;
        if (!std.mem.eql(u8, source, selected.url)) return;
    }
    if (std.mem.eql(u8, kind, "open")) {
        host_needs_save = true;
        try openURL(model, url, null);
        return;
    }
    if (std.mem.eql(u8, kind, "related")) {
        host_needs_save = true;
        var parent = model.session.selected;
        if (parent) |id| if (model.session.getLink(id)) |link| {
            parent = link.parent_id orelse id;
        };
        try openURL(model, url, parent);
        return;
    }
    if (std.mem.eql(u8, kind, "command")) {
        const name = eventString(value, "title");
        if (std.mem.eql(u8, name, "dismiss")) model.palette = false;
        if (std.mem.eql(u8, name, "next")) try perform(model, .next_result);
        if (std.mem.eql(u8, name, "previous")) try perform(model, .previous_result);
        if (std.mem.eql(u8, name, "submit")) try submit(model);
        return;
    }
    if (std.mem.eql(u8, kind, "navigate")) {
        model.loading = true;
        if (model.session.selected) |id| try cache.body(id, "");
    }
    if (std.mem.eql(u8, kind, "loaded") or std.mem.eql(u8, kind, "title")) {
        host_needs_save = true;
        const title = eventString(value, "title");
        if (model.session.selected) |id| {
            const link = model.session.getLink(id) orelse return;
            if ((source.len == 0 or std.mem.eql(u8, source, link.url)) and title.len > 0 and title.len <= 512) try model.session.updateTitle(id, title);
        }
        if (std.mem.eql(u8, kind, "loaded")) {
            model.loading = false;
            if (model.session.selected) |id| try model.session.select(id);
        }
    }
    if (std.mem.eql(u8, kind, "content")) {
        if (model.session.selected) |id| {
            const link = model.session.getLink(id) orelse return;
            if (!std.mem.eql(u8, eventString(value, "source"), link.url)) return;
            const content = eventString(value, "text");
            try cache.body(id, content);
        }
    }
    if (std.mem.eql(u8, kind, "error")) {
        model.loading = false;
        model.error_page = true;
        model.status_len = 0;
    }
}
fn drag(model: *Model, value: t.Drag, is_section: bool) !void {
    if (value.phase == 2) {
        model.drag_id = null;
        return;
    }
    model.drag_id = value.sourceId;
    model.drag_section = is_section;
    if (value.x > t.sidebar_width + 24 or value.y < t.header_height) {
        if (value.phase == 1) model.drag_id = null;
        return;
    }
    ui.updateDrop(model, value, is_section);
    if (value.phase == 1) {
        model.drag_id = null;
        if (is_section) {
            if (model.drop_before != value.sourceId) try model.session.moveSection(value.sourceId, model.drop_before);
        } else {
            model.session.moveLink(value.sourceId, model.drop_section, model.drop_before) catch |err| {
                if (err != error.InvalidMoveTarget) return err;
            };
            if (model.drop_section == 0) {
                model.session.inbox_collapsed = false;
            } else {
                for (model.session.sections.items) |*section| {
                    if (section.id == model.drop_section) section.collapsed = false;
                }
            }
        }
    }
}
fn perform(model: *Model, msg: Msg) anyerror!void {
    switch (msg) {
        .viewport => |size| model.viewport = size,
        .chrome => |chrome| {
            model.controls_center_y = if (chrome.buttons.height > 0) chrome.buttons.y + chrome.buttons.height / 2 else 24;
            model.controls_leading = @max(84, chrome.insets.left);
        },
        .fullscreen => {
            model.palette = false;
            shelf_shell_fullscreen();
        },
        .focus_command => palette(model, .search, null),
        .command => if (model.palette) {
            model.palette = false;
        } else {
            palette(model, .search, null);
        },
        .dismiss => model.palette = false,
        .home => {
            model.session.selected = null;
            model.palette = false;
            model.error_page = false;
            model.status_len = 0;
        },
        .sidebar => {
            model.session.sidebar_visible = !model.session.sidebar_visible;
            model.palette = false;
        },
        .select => |id| {
            try model.session.select(id);
            reveal(model, id);
        },
        .close_link => |id| try closeLink(model, id),
        .close_active => {
            if (model.palette) model.palette = false else if (model.session.selected) |id| try closeLink(model, id);
        },
        .reopen => {
            try model.session.reopen();
            if (model.session.selected) |id| reveal(model, id);
            model.palette = false;
            model.status_len = 0;
            model.error_page = false;
        },
        .toggle_section => |id| try model.session.toggleSection(id),
        .close_section => |id| {
            try model.session.closeSection(id);
            releaseClosedViews(model);
            model.palette = false;
            model.error_page = false;
            model.status_len = 0;
        },
        .create_section => palette(model, .create, null),
        .move => |id| palette(model, .move, id),
        .rename => |id| palette(model, .rename, id),
        .choose_section => |id| {
            const link_id = model.target orelse return;
            try model.session.moveLink(link_id, id, null);
            reveal(model, link_id);
        },
        .query => |event| try applyQuery(model, event),
        .submit => try submit(model),
        .choice => |index| try choose(model, index),
        .next_result, .previous_result => {
            var arena = std.heap.ArenaAllocator.init(allocator);
            defer arena.deinit();
            const count = commands.choices(model, arena.allocator()).len;
            if (count > 0) model.cursor = if (msg == .next_result) (model.cursor + 1) % count else (model.cursor + count - 1) % count;
        },
        .hover => |id| model.hover = id,
        .hover_section => |id| model.hover_section = id,
        .scroll => |state| model.scroll = state.offset_y,
        .drag_link => |value| try drag(model, value, false),
        .drag_section => |value| try drag(model, value, true),
        .cycle => |direction| {
            if (model.session.cycle(direction)) |id| reveal(model, id);
        },
        .ordinal => |number| {
            const index = if (number == 9) model.session.links.items.len -| 1 else number -| 1;
            if (model.session.linkAtVisualOrdinal(index)) |id| {
                try model.session.select(id);
                reveal(model, id);
            }
        },
        .reload => {
            model.error_page = false;
            model.palette = false;
            model.loading = true;
            shelf_host_reload();
        },
        .back => {
            model.palette = false;
            shelf_host_back();
        },
        .forward => {
            model.palette = false;
            shelf_host_forward();
        },
        .copy_link => |id| {
            const link = model.session.getLink(id) orelse return;
            const url = try allocator.dupeZ(u8, link.url);
            defer allocator.free(url);
            shelf_host_copy(url);
        },
        .copy_url => {
            if (model.session.selected) |id| {
                const link = model.session.getLink(id) orelse return;
                const url = try allocator.dupeZ(u8, link.url);
                defer allocator.free(url);
                shelf_host_copy(url);
            }
            model.palette = false;
        },
        .host_event => |length| try handleHost(model, event_buffer[0..length]),
    }
}
fn preparePages(model: *Model, force: bool) !void {
    if (!cache.enabled) return;
    var ids: [512]u64 = undefined;
    const page = ui.pageLinkIds(model, ids[0 .. ids.len - model.search_ids.len]);
    if (!force and page.first == model.page_first and page.end == model.page_end) return;
    model.search_count = 0;
    if (model.palette and model.mode == .search) {
        const matches = try cache.search(model.query(), &model.search_ids);
        model.search_count = matches.len;
    }
    @memcpy(ids[page.count..][0..model.search_count], model.search_ids[0..model.search_count]);
    try model.session.preparePage(ids[0 .. page.count + model.search_count]);
    model.page_first = page.first;
    model.page_end = page.end;
    cache.trace(&model.session, page.first, page.end);
}
fn update(model: *Model, msg: Msg) void {
    // SDK 0.10.1 can retain stale chrome when a page/palette changes. One
    // settling emission is sufficient; scroll and hover never need it.
    switch (msg) {
        .scroll, .hover, .hover_section => {},
        else => refresh_pending = true,
    }
    perform(model, msg) catch |err| {
        status(model, switch (err) {
            error.InvalidUrl => "Use an HTTPS link, or HTTP on localhost.",
            error.InvalidText => "Enter a section name (1–128 characters).",
            error.NoClosedItems => "No recently closed links or sections.",
            error.LinkLimitReached => "This session has 1,000 links. Close some links before opening more.",
            else => @errorName(err),
        });
    };
    model.window_scroll = model.scroll;
    shelf_shell_palette_open(@intFromBool(model.palette));
    const should_save = switch (msg) {
        .viewport, .chrome, .fullscreen, .focus_command, .hover, .hover_section, .scroll, .query, .command, .dismiss, .next_result, .previous_result => false,
        .drag_link, .drag_section => |value| value.phase == 1,
        .host_event => host_needs_save,
        else => true,
    };
    if (should_save) {
        cache.sync(&model.session) catch |err| status(model, @errorName(err));
        save(model);
    }
    switch (msg) {
        .hover, .hover_section => preparePages(model, false) catch |err| status(model, @errorName(err)),
        .next_result, .previous_result => {},
        else => preparePages(model, msg != .scroll) catch |err| status(model, @errorName(err)),
    }
}
fn onFrame(model: *const Model, frame: sdk.platform.GpuFrame) ?Msg {
    if (model.viewport.width != frame.size.width or model.viewport.height != frame.size.height) return .{ .viewport = frame.size };
    if (refresh_pending) {
        refresh_pending = false;
        if (live_runtime) |runtime| {
            _ = runtime.emitCanvasWidgetDisplayList(1, "canvas", runtime.tokensWithTextMeasure(ui.tokens())) catch return null;
            runtime.invalidate();
        }
    }
    // Native scrolling translates retained rows. Refill the buffered window
    // only after it moves far enough, not for every wheel/momentum event.
    if (model.session.sidebar_visible) if (live_runtime) |runtime| {
        if (runtime.canvasWidgetLayout(1, "canvas")) |layout| {
            if (layout.findById(ui.sidebar_scroll_id)) |node| {
                if (@abs(node.widget.value - model.window_scroll) > ui.scroll_refill_distance)
                    return .{ .scroll = .{ .offset_y = node.widget.value } };
            }
        } else |_| {}
    };
    if (!viewer_enabled) return null;
    var buffer: [4097:0]u8 = @splat(0);
    if (model.session.selected) |id| if (model.session.getLink(id)) |link| {
        @memcpy(buffer[0..link.url.len], link.url);
    };
    shelf_host_update(&buffer, if (model.session.sidebar_visible) t.sidebar_width else 0, if (model.error_page or model.session.selected == null or model.palette) 1 else if (model.loading) 2 else 0);

    if (!callback_ready) {
        callback_ready = true;
        shelf_host_set_callback(hostEvent);
    }
    return null;
}
fn onCommand(raw_name: []const u8) ?Msg {
    if (std.mem.eql(u8, raw_name, "app.command-location") or std.mem.eql(u8, raw_name, "app.command-new")) return .focus_command;
    const name = raw_name[0 .. std.mem.indexOf(u8, raw_name, "-alias") orelse raw_name.len];
    const map = .{
        .{ "app.command", Msg.command },         .{ "app.close", Msg.close_active },    .{ "app.reopen", Msg.reopen },   .{ "app.sidebar", Msg.sidebar },            .{ "app.home", Msg.home },
        .{ "app.reload", Msg.reload },           .{ "app.back", Msg.back },             .{ "app.forward", Msg.forward }, .{ "app.new-section", Msg.create_section }, .{ "app.next", Msg{ .cycle = 1 } },
        .{ "app.previous", Msg{ .cycle = -1 } }, .{ "app.fullscreen", Msg.fullscreen },
    };
    inline for (map) |entry| if (std.mem.eql(u8, name, entry[0])) return entry[1];
    if (std.mem.eql(u8, name, "app.move")) {
        if (live_app) |app| if (app.model.session.selected) |id| return .{ .move = id };
    }
    if (std.mem.startsWith(u8, name, "app.tab-")) return .{ .ordinal = std.fmt.parseInt(usize, name[8..], 10) catch return null };
    return null;
}
pub fn main(init: std.process.Init) !void {
    if (viewer_enabled) shelf_host_install();
    ui.registerIcons();
    defer if (viewer_enabled) shelf_host_shutdown();
    const app = try App.create(allocator, .{ .name = "shelf-desktop", .scene = .{ .windows = &windows }, .canvas_label = "canvas", .tokens = ui.tokens(), .update = update, .view = ui.view, .on_command = onCommand, .on_frame = onFrame, .on_chrome = chromeChanged, .sync = ui.syncScroll });
    defer app.destroy();
    app.model = .{};
    restore(&app.model);
    app.model.loading = app.model.session.selected != null;
    cache.start(&app.model.session) catch |err| status(&app.model, @errorName(err));
    defer cache.stop();
    preparePages(&app.model, true) catch |err| status(&app.model, @errorName(err));
    defer app.model.session.deinit();
    live_app = app;
    shelf_shell_keys_install(paletteKey);
    defer {
        shelf_shell_keys_install(null);
        live_app = null;
        live_runtime = null;
        shelf_host_set_callback(null);
    }
    var native_app = app.app();
    native_app.start_fn = start;
    try runner.runWithOptions(native_app, .{ .app_name = "shelf-desktop", .window_title = "Shelf", .bundle_id = "in.pyxo.shelf.desktop", .icon_path = std.mem.span(shelf_bundle_icon_path()), .default_frame = sdk.geometry.RectF.init(0, 0, 1200, 800), .js_window_api = false }, init);
}
