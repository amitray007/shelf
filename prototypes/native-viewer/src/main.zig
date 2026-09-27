//! Disposable feasibility check, not the Shelf desktop product.
const std = @import("std");
const runner = @import("runner");
const sdk = @import("native_sdk");
pub const panic = std.debug.FullPanic(sdk.debug.capturePanic);
const Model = struct { related: bool = false, reload_token: u64 = 0, artifact_url: []const u8 = "https://native-sdk.dev/" };
const Msg = union(enum) { artifact, related, reload };
const Viewer = sdk.UiApp(Model, Msg);
const views = [_]sdk.ShellView{
    .{ .label = "canvas", .kind = .gpu_surface, .fill = true, .gpu_backend = .metal },
    .{ .label = "viewer", .kind = .webview, .parent = "canvas", .url = "https://native-sdk.dev/", .x = 240, .y = 0, .width = 860, .height = 760 },
};
const windows = [_]sdk.ShellWindow{.{ .label = "main", .title = "Shelf Viewer - Feasibility", .width = 1100, .height = 760, .views = &views }};
fn update(model: *Model, msg: Msg) void {
    switch (msg) {
        .artifact => model.related = false,
        .related => model.related = true,
        .reload => model.reload_token += 1,
    }
}
fn view(ui: *Viewer.Ui, model: *const Model) Viewer.Ui.Node {
    return ui.row(.{ .grow = 1 }, .{
        ui.column(.{ .width = 240, .padding = 16, .gap = 12 }, .{
            ui.text(.{}, "Shelf"),
            ui.text(.{}, "Runtime feasibility check"),
            ui.button(.{ .on_press = .artifact }, "Artifact"),
            ui.button(.{ .on_press = .related }, "Related page"),
            ui.button(.{ .on_press = .reload }, "Reload"),
            ui.text(.{}, if (model.related) "Related page selected" else "Artifact selected"),
            ui.text(.{}, "One live WebKit view"),
        }),
        ui.panel(.{ .grow = 1, .semantics = .{ .label = "content" } }, .{}),
    });
}
fn panes(model: *const Model, out: []Viewer.WebViewPane) usize {
    out[0] = .{ .label = "viewer", .anchor = "content", .url = if (model.related) "https://native-sdk.dev/docs/native-surfaces" else model.artifact_url, .reload_token = model.reload_token };
    return 1;
}
pub fn main(init: std.process.Init) !void {
    const app = try Viewer.create(std.heap.page_allocator, .{
        .name = "shelf-native-feasibility", .scene = .{ .windows = &windows },
        .canvas_label = "canvas", .update = update, .view = view, .web_panes = panes,
    });
    defer app.destroy();
    app.model = .{ .artifact_url = init.environ_map.get("SHELF_VIEWER_URL") orelse "https://native-sdk.dev/" };
    const origins = [_][]const u8{ "https://native-sdk.dev", init.environ_map.get("SHELF_VIEWER_ORIGIN") orelse "https://native-sdk.dev" };
    try runner.runWithOptions(app.app(), .{
        .app_name = "shelf-native-feasibility", .window_title = "Shelf Viewer - Feasibility",
        .bundle_id = "dev.shelf.viewer-feasibility", .default_frame = sdk.geometry.RectF.init(0, 0, 1100, 760),
        .js_window_api = false,
        .security = .{ .permissions = &.{sdk.security.permission_view}, .navigation = .{ .allowed_origins = &origins } },
    }, init);
}
