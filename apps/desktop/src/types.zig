const std = @import("std");
const sdk = @import("native_sdk");
pub const Session = @import("session.zig").Session;
pub const Mode = enum { search, create, move, rename, close_section };
pub const Drag = struct { sourceId: u64, phase: u8 = 0, x: f32 = 0, y: f32 = 0, viewWidth: f32 = 0, viewHeight: f32 = 0 };
pub const Model = struct {
    viewport: sdk.geometry.SizeF = .{ .width = 1200, .height = 800 },
    controls_center_y: f32 = 26,
    controls_leading: f32 = 84,
    palette_generation: u64 = 0,
    session: Session = Session.init(std.heap.page_allocator),
    search_ids: [64]u64 = @splat(0),
    search_count: usize = 0,
    page_first: usize = std.math.maxInt(usize),
    page_end: usize = 0,
    palette: bool = false,
    mode: Mode = .search,
    target: ?u64 = null,
    query_buffer: [4096]u8 = @splat(0),
    query_len: usize = 0,
    query_selection: sdk.canvas.TextSelection = .{},
    query_composition: ?sdk.canvas.TextRange = null,
    cursor: usize = 0,
    hover: ?u64 = null,
    hover_section: ?u64 = null,
    scroll: f32 = 0,
    window_scroll: f32 = 0,
    observed_scroll: f32 = 0,
    status_buffer: [256]u8 = @splat(0),
    status_len: usize = 0,
    error_page: bool = false,
    loading: bool = false,
    persistence_blocked: bool = false,
    drag_id: ?u64 = null,
    drag_section: bool = false,
    drop_section: u64 = 0,
    drop_before: ?u64 = null,
    pub fn query(self: *const Model) []const u8 {
        return self.query_buffer[0..self.query_len];
    }
    pub fn status(self: *const Model) []const u8 {
        return self.status_buffer[0..self.status_len];
    }
};
pub const Msg = union(enum) {
    viewport: sdk.geometry.SizeF,
    chrome: sdk.platform.WindowChrome,
    fullscreen,
    focus_command,
    command,
    dismiss,
    home,
    sidebar,
    reopen,
    close_active,
    reload,
    back,
    forward,
    copy_url,
    select: u64,
    copy_link: u64,
    close_link: u64,
    toggle_section: u64,
    close_section: u64,
    create_section,
    move: u64,
    rename: u64,
    choose_section: u64,
    query: sdk.canvas.TextInputEvent,
    submit,
    next_result,
    previous_result,
    choice: usize,
    hover: ?u64,
    hover_section: ?u64,
    scroll: sdk.canvas.ScrollState,
    drag_link: Drag,
    drag_section: Drag,
    cycle: i8,
    ordinal: usize,
    host_event: usize,
};
pub const App = sdk.UiApp(Model, Msg);
pub const Choice = struct { label: []const u8, detail: []const u8 = "", icon: []const u8 = "", action: Msg };
pub const sidebar_width: f32 = 256;
pub const header_height: f32 = 100;
pub const row_height: f32 = 34;
pub const section_height: f32 = 28;
