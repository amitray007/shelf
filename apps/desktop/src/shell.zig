//! Window shell and command entry point, built against the approved sidebar mockup.
const std = @import("std");
const runner = @import("runner");
const sdk = @import("native_sdk");
extern fn shelf_bundle_icon_path() [*:0]const u8;
extern fn shelf_shell_keys_install(?*const fn (u8) callconv(.c) void) void;
extern fn shelf_shell_palette_open(c_int) void;
extern fn shelf_shell_fullscreen() void;
const Model = struct {
    sidebar: bool = true,
    inbox_collapsed: bool = false,
    viewport: sdk.geometry.SizeF = .{ .width = 1200, .height = 800 },
    controls_center_y: f32 = 26,
    controls_leading: f32 = 84,
    palette: bool = false,
    query_buffer: [1024]u8 = @splat(0),
    query_len: usize = 0,
    selection: sdk.canvas.TextSelection = .{},
    composition: ?sdk.canvas.TextRange = null,
    cursor: usize = 0,
    fn query(self: *const Model) []const u8 {
        return self.query_buffer[0..self.query_len];
    }
};
const Msg = union(enum) {
    toggle_inbox,
    sidebar,
    command,
    focus_command,
    viewport: sdk.geometry.SizeF,
    dismiss,
    home,
    fullscreen,
    next,
    previous,
    submit,
    query: sdk.canvas.TextInputEvent,
    choose: usize,
    chrome: sdk.platform.WindowChrome,
};
const App = sdk.UiApp(Model, Msg);
const Node = App.Ui.Node;
var active_runtime: ?*sdk.Runtime = null;
var active_app: ?*App = null;
var refresh_pending: u8 = 0;
const brand = sdk.canvas.svg_icon.parseComptime(@embedFile("brand.svg"));
const wordmark = sdk.canvas.svg_icon.parseComptime(@embedFile("wordmark.svg"));
const fullscreen_icon = sdk.canvas.svg_icon.parseComptime(@embedFile("fullscreen.svg"));
const app_icons = [_]sdk.canvas.icons.Entry{ .{ .name = "shelf", .icon = &brand }, .{ .name = "wordmark", .icon = &wordmark }, .{ .name = "fullscreen", .icon = &fullscreen_icon } };
const clear = sdk.canvas.Color.rgba8(0, 0, 0, 0);
const background = sdk.canvas.Color.rgb8(17, 17, 17);
const content = sdk.canvas.Color.rgb8(8, 8, 8);
const primary = sdk.canvas.Color.rgb8(237, 237, 237);
const muted = sdk.canvas.Color.rgb8(160, 160, 160);
const border = sdk.canvas.Color.rgb8(46, 46, 46);
const sidebar_width: f32 = 256;
const header_height: f32 = 48;
const sidebar_inset: f32 = 16;
const identity_height: f32 = 40;
const group_gap: f32 = 12;
const views = [_]sdk.ShellView{.{ .label = "canvas", .kind = .gpu_surface, .fill = true, .gpu_backend = .metal }};
const windows = [_]sdk.ShellWindow{.{ .label = "main", .title = "Shelf", .width = 1200, .height = 800, .min_width = 720, .min_height = 480, .titlebar = .hidden_inset_tall, .views = &views }};
fn theme() sdk.canvas.DesignTokens {
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
fn start(_: *anyopaque, runtime: *sdk.Runtime) !void {
    active_runtime = runtime;
}
fn frame(model: *const Model, current: sdk.platform.GpuFrame) ?Msg {
    if (model.viewport.width != current.size.width or model.viewport.height != current.size.height) return .{ .viewport = current.size };
    // Native SDK 0.10.1 can leave the presented canvas stale after topology changes.
    if (refresh_pending > 0) {
        refresh_pending -= 1;
        if (active_runtime) |runtime| {
            _ = runtime.emitCanvasWidgetDisplayList(1, "canvas", runtime.tokensWithTextMeasure(theme())) catch return null;
            runtime.invalidate();
        }
    }
    return null;
}
fn paletteKey(key: u8) callconv(.c) void {
    const app = active_app orelse return;
    const runtime = active_runtime orelse return;
    if (!app.model.palette) return;
    app.dispatch(runtime, 1, if (key == 1) .next else .previous) catch {};
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
        ui.button(.{ .grow = 1, .width = options.width, .height = options.height, .variant = .ghost, .on_press = options.on_press, .style = .{ .background = clear, .border = clear, .foreground = clear, .radius = options.style.radius }, .semantics = options.semantics }, ""),
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
            ui.el(.stack, .{ .width = if (model.sidebar) sidebar_width - sidebar_inset - 32 else model.controls_leading }, .{}),
            toggle(ui, model.sidebar),
            if (!model.sidebar) commandTrigger(ui) else ui.el(.stack, .{ .width = 0 }, .{}),
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
fn inbox(ui: *App.Ui, model: *const Model) Node {
    return ui.column(.{ .gap = 0 }, .{
        ui.el(.stack, .{ .height = group_gap }, .{}),
        pressable(ui, .{ .height = 28, .on_press = .toggle_inbox, .style = .{ .background = clear, .border = clear, .radius = 0 }, .semantics = .{ .role = .button, .label = if (model.inbox_collapsed) "Expand Inbox" else "Collapse Inbox" } }, ui.row(.{ .height = 28, .cross = .center, .gap = 8 }, .{
            ui.el(.stack, .{ .width = sidebar_inset - 8 }, .{}),
            ui.paragraph(.{ .grow = 1, .wrap = false, .style = .{ .foreground = sdk.canvas.Color.rgb8(212, 212, 212) } }, &.{.{ .text = "Inbox", .scale = 13.0 / 14.0, .weight = .medium }}),
            ui.el(.icon, .{ .icon = if (model.inbox_collapsed) "chevron-right" else "chevron-down", .width = 12, .height = 12, .style = .{ .foreground = muted } }, .{}),
            ui.el(.stack, .{ .width = sidebar_inset - 8 }, .{}),
        })),
        if (!model.inbox_collapsed) ui.column(.{ .padding = sidebar_inset, .gap = 6 }, .{
            label(ui, "All clear", 12, sdk.canvas.Color.rgb8(186, 186, 186)),
            label(ui, "New links appear here.", 12, sdk.canvas.Color.rgb8(136, 136, 136)),
            label(ui, "Paste a link with ⌘K.", 12, sdk.canvas.Color.rgb8(136, 136, 136)),
        }) else ui.el(.stack, .{}, .{}),
        ui.el(.stack, .{ .height = group_gap }, .{}),
        ui.row(.{ .height = 1 }, .{
            ui.el(.stack, .{ .width = sidebar_inset }, .{}),
            ui.panel(.{ .grow = 1, .style = .{ .background = sdk.canvas.Color.rgb8(41, 41, 41), .border = clear, .radius = 0 } }, .{}),
            ui.el(.stack, .{ .width = sidebar_inset }, .{}),
        }),
    });
}
fn view(ui: *App.Ui, model: *const Model) Node {
    return ui.el(.stack, .{ .grow = 1 }, .{
        ui.row(.{ .grow = 1, .gap = 0 }, .{
            if (model.sidebar) ui.panel(.{ .width = sidebar_width, .style = .{ .background = background, .radius = 0, .stroke_width = 0 } }, .{
                ui.column(.{ .grow = 1, .gap = 0 }, .{ header(ui, model), identity(ui), inbox(ui, model), ui.spacer(1) }),
            }) else ui.el(.stack, .{ .width = 0 }, .{}),
            if (model.sidebar) ui.panel(.{ .width = 1, .style = .{ .background = border, .radius = 0, .stroke_width = 0 } }, .{}) else ui.el(.stack, .{}, .{}),
            ui.panel(.{ .grow = 1, .style = .{ .background = content, .radius = 0, .stroke_width = 0 } }, .{
                ui.column(.{ .grow = 1, .gap = 0 }, .{ if (!model.sidebar) header(ui, model) else ui.el(.stack, .{}, .{}), ui.spacer(1) }),
            }),
        }),
        if (model.palette) ui.panel(.{ .grow = 1, .on_press = .dismiss, .style = .{ .background = sdk.canvas.Color.rgba8(0, 0, 0, 136), .border = clear, .radius = 0 } }, .{}) else ui.el(.stack, .{}, .{}),
        if (model.palette) paletteView(ui, model) else ui.el(.stack, .{}, .{}),
    });
}
const Choice = struct { title: []const u8, detail: []const u8 = "", icon: []const u8, key: []const u8, action: Msg };
fn matches(text: []const u8, query: []const u8) bool {
    if (query.len > text.len) return false;
    for (0..text.len - query.len + 1) |i| if (std.ascii.eqlIgnoreCase(text[i..][0..query.len], query)) return true;
    return false;
}
fn choices(model: *const Model, out: *[8]Choice) []const Choice {
    const all = [_]Choice{
        .{ .title = if (model.sidebar) "Hide sidebar" else "Show sidebar", .icon = "panel-left", .key = "⌘ \\", .action = .sidebar },
        .{ .title = "Toggle full screen", .icon = "app:fullscreen", .key = "⌃ ⌘ F", .action = .fullscreen },
        .{ .title = "Shelf Home", .icon = "app:shelf", .key = "", .action = .home },
    };
    var n: usize = 0;
    const query = std.mem.trim(u8, model.query(), " \t\r\n");
    for (all) |item| if (matches(item.title, query)) {
        out[n] = item;
        n += 1;
    };
    return out[0..n];
}
fn paletteView(ui: *App.Ui, model: *const Model) Node {
    var storage: [8]Choice = undefined;
    const items = choices(model, &storage);
    const rows = ui.arena.alloc(Node, items.len) catch return ui.column(.{}, .{});
    for (items, 0..) |item, index| {
        var icon = ui.el(.icon, .{ .width = 16, .height = 16, .style = .{ .foreground = muted } }, .{});
        icon.widget.text = item.icon;
        rows[index] = pressable(
            ui,
            .{ .key = .{ .int = index }, .height = 44, .padding = 0, .on_press = .{ .choose = index }, .selected = index == model.cursor, .style = .{ .background = if (index == model.cursor) sdk.canvas.Color.rgb8(41, 41, 41) else background, .border = if (index == model.cursor) sdk.canvas.Color.rgb8(62, 62, 62) else background, .stroke_width = 1, .radius = 6 }, .semantics = .{ .role = .button, .label = item.title } },
            ui.row(.{ .padding = 12, .gap = 12, .cross = .center }, .{ icon, label(ui, item.title, 14, primary), ui.spacer(1), label(ui, item.key, 12, muted) }),
        );
    }
    return ui.el(.popover, .{ .frame = .{ .x = (model.viewport.width - 560) / 2, .y = 96 }, .width = 560, .height = @as(f32, @floatFromInt(@max(items.len, 1))) * 44 + 108, .padding = 0, .on_dismiss = .dismiss, .style = .{ .background = background, .border = sdk.canvas.Color.rgb8(69, 69, 69), .stroke_width = 1, .radius = 12 }, .semantics = .{ .label = "Search links and commands" } }, .{
        ui.column(.{ .grow = 1, .gap = 0 }, .{
            ui.row(.{ .height = 64, .padding = 16, .gap = 12, .cross = .center }, .{
                ui.icon(.{ .width = 20, .height = 20, .style = .{ .foreground = muted } }, "search"),
                ui.textField(.{ .key = .{ .int = 9000 }, .grow = 1, .height = 32, .padding = 0, .text = model.query(), .placeholder = "Search commands…", .autofocus = true, .on_input = App.Ui.inputMsg(.query), .on_submit = .submit, .style = .{ .background = background, .foreground = if (model.query_len == 0) muted else primary, .border = clear, .focus_ring = clear, .stroke_width = 0, .radius = 0 }, .semantics = .{ .label = "Search commands" } }),
                pressable(ui, .{ .width = 28, .height = 20, .on_press = .dismiss, .style = .{ .background = background, .border = border, .radius = 4 }, .semantics = .{ .role = .button, .label = "Dismiss command menu · Escape" } }, ui.row(.{ .main = .center, .cross = .center }, .{label(ui, "esc", 10, muted)})),
            }),
            ui.panel(.{ .height = 1, .style = .{ .background = border, .stroke_width = 0, .radius = 0 } }, .{}),
            ui.row(.{ .height = 28, .padding = 16, .cross = .center }, .{label(ui, "Actions", 12, muted)}),
            ui.column(.{ .height = @as(f32, @floatFromInt(items.len)) * 44 + 16, .padding = 8, .gap = 0 }, rows),
            if (items.len == 0) ui.row(.{ .height = 44, .padding = 16 }, .{label(ui, "No matching commands.", 14, muted)}) else ui.el(.stack, .{}, .{}),
        }),
    });
}
fn openPalette(model: *Model) void {
    model.palette = true;
    model.query_len = 0;
    model.selection = .{};
    model.composition = null;
    model.cursor = 0;
}
fn update(model: *Model, msg: Msg) void {
    switch (msg) {
        .toggle_inbox => model.inbox_collapsed = !model.inbox_collapsed,
        .viewport => |size| model.viewport = size,
        .focus_command => openPalette(model),
        .sidebar => {
            model.sidebar = !model.sidebar;
            model.palette = false;
        },
        .command => if (model.palette) {
            model.palette = false;
        } else {
            openPalette(model);
        },
        .dismiss, .home => model.palette = false,
        .fullscreen => {
            model.palette = false;
            shelf_shell_fullscreen();
        },
        .query => |event| {
            var buffer: [1024]u8 = undefined;
            const next = (sdk.canvas.TextEditState{ .text = model.query(), .selection = model.selection, .composition = model.composition }).apply(event, &buffer) catch return;
            @memcpy(model.query_buffer[0..next.text.len], next.text);
            model.query_len = next.text.len;
            model.selection = next.selection;
            model.composition = next.composition;
            model.cursor = 0;
        },
        .next, .previous => {
            var storage: [8]Choice = undefined;
            const items = choices(model, &storage);
            if (items.len > 0) model.cursor = if (msg == .next) (model.cursor + 1) % items.len else (model.cursor + items.len - 1) % items.len;
        },
        .submit, .choose => {
            var storage: [8]Choice = undefined;
            const items = choices(model, &storage);
            const index = if (msg == .choose) msg.choose else model.cursor;
            if (index < items.len) update(model, items[index].action);
        },
        .chrome => |chrome| {
            model.controls_center_y = if (chrome.buttons.height > 0) chrome.buttons.y + chrome.buttons.height / 2 else header_height / 2;
            model.controls_leading = @max(84, chrome.insets.left);
        },
    }
    shelf_shell_palette_open(@intFromBool(model.palette));
    refresh_pending = 2;
}
fn chromeChanged(chrome: sdk.platform.WindowChrome) ?Msg {
    return .{ .chrome = chrome };
}
fn command(name: []const u8) ?Msg {
    if (std.mem.eql(u8, name, "app.sidebar")) return .sidebar;
    if (std.mem.eql(u8, name, "app.command")) return .command;
    if (std.mem.eql(u8, name, "app.command-location") or std.mem.eql(u8, name, "app.command-new")) return .focus_command;
    return null;
}
pub fn run(init: std.process.Init) !void {
    sdk.canvas.icons.registerAppIcons(&app_icons);
    const app = try App.create(std.heap.page_allocator, .{ .name = "shelf-shell", .scene = .{ .windows = &windows }, .canvas_label = "canvas", .tokens = theme(), .update = update, .view = view, .on_command = command, .on_frame = frame, .on_chrome = chromeChanged });
    defer app.destroy();
    active_app = app;
    shelf_shell_keys_install(paletteKey);
    defer {
        shelf_shell_keys_install(null);
        active_app = null;
        active_runtime = null;
    }
    var native_app = app.app();
    native_app.start_fn = start;
    try runner.runWithOptions(native_app, .{ .app_name = "shelf-desktop", .window_title = "Shelf", .bundle_id = "in.pyxo.shelf.desktop", .icon_path = std.mem.span(shelf_bundle_icon_path()), .default_frame = sdk.geometry.RectF.init(0, 0, 1200, 800), .js_window_api = false }, init);
}
