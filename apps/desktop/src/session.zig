const std = @import("std");

pub const max_links = 1000;
pub const max_sections = 100;
const max_url_length = 4096;
const max_title_length = 512;
const max_section_name_length = 128;

pub const Link = struct {
    id: u64,
    url: []const u8,
    title: []const u8,
    section_id: u64 = 0,
    parent_id: ?u64 = null,
    unread: bool = false,
};

/// Owned link strings returned by a payload cache read.
pub const Payload = struct {
    url: []const u8,
    title: []const u8,
};

/// Optional backing store for link strings that are outside the current page.
pub const PayloadCache = struct {
    context: *anyopaque,
    put: *const fn (context: *anyopaque, id: u64, url: []const u8, title: []const u8) anyerror!void,
    read: *const fn (context: *anyopaque, allocator: std.mem.Allocator, id: u64) anyerror!Payload,
    find_url: *const fn (context: *anyopaque, url: []const u8) anyerror!?u64,
};

pub const Section = struct {
    id: u64,
    name: []const u8,
    collapsed: bool = false,
};

const ClosedBatch = struct {
    links: std.ArrayList(Link) = .empty,
    section: ?Section = null,
    before_id: ?u64 = null,

    fn deinit(self: *ClosedBatch, allocator: std.mem.Allocator) void {
        for (self.links.items) |link| freeLink(allocator, link);
        self.links.deinit(allocator);
        if (self.section) |section| allocator.free(section.name);
    }
};

const Persisted = struct {
    version: u8 = 1,
    next_id: u64,
    sections: []const Section,
    links: []const Link,
    selected: ?u64,
    sidebar_visible: bool,
    inbox_collapsed: bool = false,
    closed: []const PersistedClosed = &.{},
};

const PersistedClosed = struct {
    links: []const Link,
    section: ?Section,
    before_id: ?u64,
};

/// Framework-independent desktop session state. Inbox is section id 0 and is implicit.
pub const Session = struct {
    allocator: std.mem.Allocator,
    links: std.ArrayList(Link) = .empty,
    sections: std.ArrayList(Section) = .empty,
    selected: ?u64 = null,
    sidebar_visible: bool = true,
    inbox_collapsed: bool = false,
    next_id: u64 = 1,
    closed: std.ArrayList(ClosedBatch) = .empty,
    payload_cache: ?PayloadCache = null,

    pub fn init(allocator: std.mem.Allocator) Session {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Session) void {
        for (self.links.items) |link| freeLink(self.allocator, link);
        self.links.deinit(self.allocator);
        for (self.sections.items) |section| self.allocator.free(section.name);
        self.sections.deinit(self.allocator);
        for (self.closed.items) |*batch| batch.deinit(self.allocator);
        self.closed.deinit(self.allocator);
    }

    pub fn open(self: *Session, url: []const u8, title: []const u8, parent: ?u64) !u64 {
        try validateUrl(url);
        try validateText(title, max_title_length);
        if (try self.findActiveUrl(url)) |existing| {
            try self.select(existing.id);
            return existing.id;
        }
        if (self.links.items.len >= max_links) return error.LinkLimitReached;

        var section_id: u64 = 0;
        if (parent) |parent_id| {
            const parent_link = self.findLink(parent_id) orelse return error.UnknownLink;
            section_id = parent_link.section_id;
        }
        const owned_url = try self.allocator.dupe(u8, url);
        errdefer self.allocator.free(owned_url);
        const owned_title = try self.allocator.dupe(u8, title);
        errdefer self.allocator.free(owned_title);
        const id = self.next_id;
        if (id == std.math.maxInt(u64)) return error.IdExhausted;
        try self.putPayload(id, owned_url, owned_title);
        const link = Link{
            .id = try self.allocateId(),
            .url = owned_url,
            .title = owned_title,
            .section_id = section_id,
            .parent_id = parent,
            .unread = false,
        };
        const index = if (parent) |parent_id| self.endOfFamily(parent_id) else self.frontOfSection(section_id);
        try self.links.insert(self.allocator, index, link);
        self.selected = link.id;
        return link.id;
    }

    pub fn select(self: *Session, id: u64) !void {
        const link = self.findLinkMut(id) orelse return error.UnknownLink;
        link.unread = false;
        self.selected = id;
    }

    /// Returned strings remain owned by the session.
    pub fn getLink(self: *const Session, id: u64) ?Link {
        const mutable = @constCast(self);
        _ = mutable.hydrateLink(id) catch return null;
        return self.findLink(id);
    }

    /// Seeds the cache before attaching it, leaving this session unchanged if seeding fails.
    pub fn enablePayloadCache(self: *Session, cache: PayloadCache) !void {
        if (self.payload_cache != null) return error.PayloadCacheAlreadyEnabled;
        for (self.links.items) |link| try cache.put(cache.context, link.id, link.url, link.title);
        for (self.closed.items) |batch| for (batch.links.items) |link| try cache.put(cache.context, link.id, link.url, link.title);
        self.payload_cache = cache;
    }

    /// Keeps requested and selected active links resident, and evicts every other payload.
    pub fn preparePage(self: *Session, ids: []const u64) !void {
        if (self.payload_cache == null) return;
        for (ids) |id| _ = try self.hydrateLink(id);
        if (self.selected) |id| _ = try self.hydrateLink(id);

        for (self.links.items) |*link| {
            if (!containsId(ids, link.id) and self.selected != link.id) self.evictPayload(link);
        }
        for (self.closed.items) |*batch| for (batch.links.items) |*link| self.evictPayload(link);
    }

    /// Inbox is permanent but can be collapsed.
    pub fn getSection(self: *const Session, id: u64) ?Section {
        if (id == 0) return .{ .id = 0, .name = "Inbox", .collapsed = self.inbox_collapsed };
        const index = self.sectionIndex(id) orelse return null;
        return self.sections.items[index];
    }

    pub fn updateTitle(self: *Session, id: u64, title: []const u8) !void {
        try validateText(title, max_title_length);
        const link = try self.hydrateLink(id) orelse return error.UnknownLink;
        const owned = try self.allocator.dupe(u8, title);
        errdefer self.allocator.free(owned);
        try self.putPayload(link.id, link.url, owned);
        self.allocator.free(link.title);
        link.title = owned;
    }

    pub fn createSection(self: *Session, name: []const u8) !u64 {
        try validateText(name, max_section_name_length);
        if (self.sections.items.len + 1 >= max_sections) return error.SectionLimitReached;
        const section = Section{ .id = try self.allocateId(), .name = try self.allocator.dupe(u8, name) };
        errdefer self.allocator.free(section.name);
        try self.sections.append(self.allocator, section);
        return section.id;
    }

    pub fn renameSection(self: *Session, id: u64, name: []const u8) !void {
        if (id == 0) return error.InboxImmutable;
        try validateText(name, max_section_name_length);
        const section = self.findSectionMut(id) orelse return error.UnknownSection;
        const owned = try self.allocator.dupe(u8, name);
        self.allocator.free(section.name);
        section.name = owned;
    }

    pub fn toggleSection(self: *Session, id: u64) !void {
        if (id == 0) {
            self.inbox_collapsed = !self.inbox_collapsed;
            return;
        }
        const section = self.findSectionMut(id) orelse return error.UnknownSection;
        section.collapsed = !section.collapsed;
    }

    pub fn setSidebarVisible(self: *Session, visible: bool) void {
        self.sidebar_visible = visible;
    }

    /// Moves the root and all of its descendants as one contiguous unit.
    pub fn moveLink(self: *Session, id: u64, section_id: u64, before_id: ?u64) !void {
        if (!self.hasSection(section_id)) return error.UnknownSection;
        const root_id = self.rootId(id) orelse return error.UnknownLink;
        const start = self.indexOf(root_id).?;
        const end = self.endOfFamily(root_id);
        var target_root: ?u64 = null;
        if (before_id) |before| {
            const target = self.findLink(before) orelse return error.UnknownLink;
            if (target.section_id != section_id) return error.TargetInDifferentSection;
            target_root = self.rootId(before).?;
            const target_index = self.indexOf(target_root.?).?;
            if (target_index >= start and target_index < end) return error.InvalidMoveTarget;
        }

        var moved: std.ArrayList(Link) = .empty;
        defer moved.deinit(self.allocator);
        try moved.appendSlice(self.allocator, self.links.items[start..end]);
        self.links.replaceRangeAssumeCapacity(start, end - start, &.{});
        for (moved.items) |*link| link.section_id = section_id;

        var insert_at = if (target_root) |target| self.indexOf(target).? else self.endOfSection(section_id);
        if (insert_at > self.links.items.len) insert_at = self.links.items.len;
        self.links.insertSliceAssumeCapacity(insert_at, moved.items);
    }

    /// Reorders custom sections. Inbox remains implicit and first.
    pub fn moveSection(self: *Session, id: u64, before_id: ?u64) !void {
        if (id == 0) return error.InboxImmutable;
        const index = self.sectionIndex(id) orelse return error.UnknownSection;
        if (before_id) |before| {
            if (before == 0) return error.InboxImmutable;
            if (before == id) return;
            if (self.sectionIndex(before) == null) return error.UnknownSection;
        }
        const section = self.sections.orderedRemove(index);
        const target = if (before_id) |before| self.sectionIndex(before).? else self.sections.items.len;
        self.sections.insertAssumeCapacity(target, section);
    }

    /// Closing any link closes its subtree, so no descendant can keep a vanished parent.
    pub fn closeLink(self: *Session, id: u64) !void {
        _ = self.findLink(id) orelse return error.UnknownLink;
        const start = self.indexOf(id).?;
        const end = self.endOfSubtree(id);
        try self.captureAndRemove(start, end, null);
    }

    pub fn closeSection(self: *Session, id: u64) !void {
        if (id == 0) return error.InboxImmutable;
        const section_index = self.sectionIndex(id) orelse return error.UnknownSection;
        const section = self.sections.items[section_index];
        const owned = Section{ .id = section.id, .name = try self.allocator.dupe(u8, section.name), .collapsed = section.collapsed };
        errdefer self.allocator.free(owned.name);

        var start: ?usize = null;
        var end: usize = 0;
        for (self.links.items, 0..) |link, index| if (link.section_id == id) {
            if (start == null) start = index;
            end = index + 1;
        };
        if (start) |first| {
            try self.captureAndRemove(first, end, owned);
        } else {
            const batch = ClosedBatch{ .section = owned };
            try self.appendClosed(batch);
        }
        const removed = self.sections.orderedRemove(section_index);
        self.allocator.free(removed.name);
    }

    /// Restores the newest close batch. Existing links win over restored duplicates.
    /// A failed restore leaves the batch untouched for a later retry.
    pub fn reopen(self: *Session) !void {
        if (self.closed.items.len == 0) return error.NoClosedItems;
        const batch = &self.closed.items[self.closed.items.len - 1];
        var pending: std.ArrayList(Link) = .empty;
        defer {
            for (pending.items) |link| freeLink(self.allocator, link);
            pending.deinit(self.allocator);
        }
        for (batch.links.items) |saved| {
            if (self.findLink(saved.id) != null) continue;
            var read_payload: ?Payload = null;
            defer if (read_payload) |payload| {
                self.allocator.free(payload.url);
                self.allocator.free(payload.title);
            };
            const saved_url = if (saved.url.len == 0) blk: {
                const cache = self.payload_cache orelse return error.PayloadUnavailable;
                read_payload = try cache.read(cache.context, self.allocator, saved.id);
                break :blk read_payload.?.url;
            } else saved.url;
            if ((try self.findActiveUrl(saved_url)) != null) continue;
            const copied = try cloneLink(self.allocator, saved);
            pending.append(self.allocator, copied) catch |err| {
                freeLink(self.allocator, copied);
                return err;
            };
        }
        if (self.links.items.len + pending.items.len > max_links) return error.LinkLimitReached;

        var restored_section: ?Section = null;
        if (batch.section) |section| {
            if (!self.hasSection(section.id) and self.sections.items.len + 1 < max_sections) {
                restored_section = .{ .id = section.id, .name = try self.allocator.dupe(u8, section.name), .collapsed = section.collapsed };
            }
        }
        errdefer if (restored_section) |section| self.allocator.free(section.name);

        var attached_parent: ?u64 = null;
        var target_section = if (pending.items.len == 0) @as(u64, 0) else pending.items[0].section_id;
        if (pending.items.len > 0) {
            if (pending.items[0].parent_id) |parent| {
                if (self.findLink(parent)) |parent_link| {
                    attached_parent = parent;
                    target_section = parent_link.section_id;
                }
            }
        }
        if (!self.hasSection(target_section) and (restored_section == null or target_section != restored_section.?.id)) target_section = 0;

        for (pending.items) |*link| {
            link.section_id = target_section;
            if (link.parent_id) |parent| {
                var parent_found = self.findLink(parent) != null;
                if (!parent_found) {
                    for (pending.items) |candidate| {
                        if (candidate.id == parent) parent_found = true;
                    }
                }
                if (!parent_found) link.parent_id = null;
            }
        }

        try self.links.ensureUnusedCapacity(self.allocator, pending.items.len);
        if (restored_section != null) try self.sections.ensureUnusedCapacity(self.allocator, 1);
        if (restored_section) |section| self.sections.appendAssumeCapacity(section);

        var insert_at = if (attached_parent) |parent| self.endOfSubtree(parent) else self.endOfSection(target_section);
        if (batch.before_id) |before| {
            if (self.findLink(before)) |anchor| {
                if (anchor.section_id == target_section and (attached_parent == null or self.isDescendantOf(before, attached_parent.?))) {
                    insert_at = self.indexOf(before).?;
                }
            }
        }
        const reopened_id = if (pending.items.len > 0) pending.items[0].id else null;
        self.links.insertSliceAssumeCapacity(insert_at, pending.items);
        if (reopened_id) |id| self.select(id) catch {};
        pending.clearRetainingCapacity();

        var restored_batch = self.closed.pop().?;
        restored_batch.deinit(self.allocator);
    }

    pub fn cycle(self: *Session, direction: i8) ?u64 {
        if (self.links.items.len == 0) return null;
        const current = if (self.selected) |id| self.visualOrdinal(id) orelse 0 else 0;
        const next = if (direction < 0) (current + self.links.items.len - 1) % self.links.items.len else (current + 1) % self.links.items.len;
        self.select(self.linkAtVisualOrdinal(next).?) catch return null;
        return self.selected;
    }

    pub fn ordinal(self: *const Session, id: u64) ?usize {
        const index = self.visualOrdinal(id) orelse return null;
        return index + 1;
    }

    pub fn encodeJson(self: *const Session, allocator: std.mem.Allocator) ![]u8 {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const temporary = arena.allocator();
        const links = try temporary.alloc(Link, self.links.items.len);
        for (self.links.items, 0..) |link, index| links[index] = try self.copyPayloadForEncoding(temporary, link);
        const closed = try temporary.alloc(PersistedClosed, self.closed.items.len);
        for (self.closed.items, 0..) |batch, index| {
            const batch_links = try temporary.alloc(Link, batch.links.items.len);
            for (batch.links.items, 0..) |link, link_index| batch_links[link_index] = try self.copyPayloadForEncoding(temporary, link);
            closed[index] = .{ .links = batch_links, .section = batch.section, .before_id = batch.before_id };
        }
        return std.json.Stringify.valueAlloc(allocator, Persisted{
            .next_id = self.next_id,
            .sections = self.sections.items,
            .links = links,
            .selected = self.selected,
            .sidebar_visible = self.sidebar_visible,
            .inbox_collapsed = self.inbox_collapsed,
            .closed = closed,
        }, .{});
    }

    pub fn decodeJson(allocator: std.mem.Allocator, input: []const u8) !Session {
        var parsed = std.json.parseFromSlice(Persisted, allocator, input, .{ .ignore_unknown_fields = false }) catch return error.InvalidSnapshot;
        defer parsed.deinit();
        const source = parsed.value;
        if (source.version != 1 or source.next_id == 0 or source.links.len > max_links or source.sections.len + 1 > max_sections or source.closed.len > 50) return error.InvalidSnapshot;
        var session = Session.init(allocator);
        errdefer session.deinit();
        session.next_id = source.next_id;
        session.selected = source.selected;
        session.sidebar_visible = source.sidebar_visible;
        session.inbox_collapsed = source.inbox_collapsed;
        for (source.sections) |section| {
            if (section.id == 0 or session.hasAnyId(section.id)) return error.InvalidSnapshot;
            try validateText(section.name, max_section_name_length);
            const name = try allocator.dupe(u8, section.name);
            session.sections.append(allocator, .{ .id = section.id, .name = name, .collapsed = section.collapsed }) catch |err| {
                allocator.free(name);
                return err;
            };
        }
        for (source.links) |link| {
            try validatePersistedLink(&session, link);
            const copied = try cloneLink(allocator, link);
            session.links.append(allocator, copied) catch |err| {
                freeLink(allocator, copied);
                return err;
            };
        }
        if (session.selected) |id| if (session.findLink(id) == null) return error.InvalidSnapshot;
        if (!session.hasCanonicalLinkOrder()) return error.InvalidSnapshot;
        for (session.sections.items) |section| if (section.id >= session.next_id) return error.InvalidSnapshot;
        for (session.links.items) |link| if (link.id >= session.next_id) return error.InvalidSnapshot;
        for (source.closed) |stored| {
            try session.restoreClosedSnapshot(stored);
        }
        return session;
    }

    fn restoreClosedSnapshot(self: *Session, stored: PersistedClosed) !void {
        if (stored.links.len > max_links) return error.InvalidSnapshot;
        var batch = ClosedBatch{ .before_id = stored.before_id };
        errdefer batch.deinit(self.allocator);
        if (stored.section) |section| {
            if (section.id == 0) return error.InvalidSnapshot;
            try validateText(section.name, max_section_name_length);
            batch.section = .{ .id = section.id, .name = try self.allocator.dupe(u8, section.name), .collapsed = section.collapsed };
        }
        for (stored.links) |link| {
            if (self.hasAnyId(link.id) or self.closedHasLinkId(link.id)) return error.InvalidSnapshot;
            try validateClosedLink(self, &batch, link);
            const copied = try cloneLink(self.allocator, link);
            batch.links.append(self.allocator, copied) catch |err| {
                freeLink(self.allocator, copied);
                return err;
            };
        }
        try self.closed.append(self.allocator, batch);
    }

    fn captureAndRemove(self: *Session, start: usize, end: usize, section: ?Section) !void {
        try self.closed.ensureUnusedCapacity(self.allocator, 1);
        var batch = ClosedBatch{ .section = section, .before_id = if (end < self.links.items.len) self.links.items[end].id else null };
        errdefer batch.deinit(self.allocator);
        for (self.links.items[start..end]) |link| {
            const copied = try cloneLink(self.allocator, link);
            batch.links.append(self.allocator, copied) catch |err| {
                freeLink(self.allocator, copied);
                return err;
            };
        }
        for (self.links.items[start..end]) |link| freeLink(self.allocator, link);
        self.links.replaceRangeAssumeCapacity(start, end - start, &.{});
        if (self.selected) |selected| {
            if (self.findLink(selected) == null) self.selected = null;
        }
        try self.appendClosed(batch);
    }

    fn appendClosed(self: *Session, batch: ClosedBatch) !void {
        try self.closed.ensureUnusedCapacity(self.allocator, 1);
        if (self.closed.items.len == 50) {
            var oldest = self.closed.orderedRemove(0);
            oldest.deinit(self.allocator);
        }
        try self.closed.append(self.allocator, batch);
    }

    fn allocateId(self: *Session) !u64 {
        const id = self.next_id;
        if (id == std.math.maxInt(u64)) return error.IdExhausted;
        self.next_id += 1;
        return id;
    }

    fn hasSection(self: *const Session, id: u64) bool {
        return id == 0 or self.sectionIndex(id) != null;
    }

    fn hasAnyId(self: *const Session, id: u64) bool {
        if (self.sectionIndex(id) != null) return true;
        return self.indexOf(id) != null;
    }

    fn closedHasLinkId(self: *const Session, id: u64) bool {
        for (self.closed.items) |batch| for (batch.links.items) |link| if (link.id == id) return true;
        return false;
    }

    fn hasCanonicalLinkOrder(self: *const Session) bool {
        var current_root: ?u64 = null;
        for (self.links.items, 0..) |link, index| {
            if (index > 0 and self.links.items[index - 1].section_id != link.section_id) {
                for (self.links.items[0..index]) |earlier| if (earlier.section_id == link.section_id) return false;
            }
            const root = self.rootId(link.id) orelse return false;
            if (link.parent_id == null) {
                current_root = root;
            } else if (current_root == null or current_root.? != root) {
                return false;
            }
        }
        return true;
    }

    fn sectionIndex(self: *const Session, id: u64) ?usize {
        for (self.sections.items, 0..) |section, index| if (section.id == id) return index;
        return null;
    }

    fn findSectionMut(self: *Session, id: u64) ?*Section {
        const index = self.sectionIndex(id) orelse return null;
        return &self.sections.items[index];
    }

    fn findLink(self: *const Session, id: u64) ?Link {
        const index = self.indexOf(id) orelse return null;
        return self.links.items[index];
    }

    fn findLinkMut(self: *Session, id: u64) ?*Link {
        const index = self.indexOf(id) orelse return null;
        return &self.links.items[index];
    }

    fn findUrl(self: *const Session, url: []const u8) ?Link {
        for (self.links.items) |link| if (std.mem.eql(u8, link.url, url)) return link;
        return null;
    }

    fn findActiveUrl(self: *Session, url: []const u8) !?Link {
        if (self.findUrl(url)) |link| return link;
        const cache = self.payload_cache orelse return null;
        const id = try cache.find_url(cache.context, url) orelse return null;
        return self.findLink(id);
    }

    fn hydrateLink(self: *Session, id: u64) !?*Link {
        const link = self.findLinkMut(id) orelse return null;
        if (link.url.len != 0) return link;
        const cache = self.payload_cache orelse return error.PayloadUnavailable;
        const payload = try cache.read(cache.context, self.allocator, id);
        errdefer {
            self.allocator.free(payload.url);
            self.allocator.free(payload.title);
        }
        try validateUrl(payload.url);
        try validateText(payload.title, max_title_length);
        link.url = payload.url;
        link.title = payload.title;
        return link;
    }

    fn putPayload(self: *const Session, id: u64, url: []const u8, title: []const u8) !void {
        const cache = self.payload_cache orelse return;
        try cache.put(cache.context, id, url, title);
    }

    fn evictPayload(self: *Session, link: *Link) void {
        if (link.url.len == 0) return;
        self.allocator.free(link.url);
        self.allocator.free(link.title);
        link.url = &.{};
        link.title = &.{};
    }

    fn copyPayloadForEncoding(self: *const Session, allocator: std.mem.Allocator, link: Link) !Link {
        if (link.url.len != 0) return link;
        const cache = self.payload_cache orelse return error.PayloadUnavailable;
        const payload = try cache.read(cache.context, allocator, link.id);
        return .{
            .id = link.id,
            .url = payload.url,
            .title = payload.title,
            .section_id = link.section_id,
            .parent_id = link.parent_id,
            .unread = link.unread,
        };
    }

    fn indexOf(self: *const Session, id: u64) ?usize {
        for (self.links.items, 0..) |link, index| if (link.id == id) return index;
        return null;
    }

    fn rootId(self: *const Session, id: u64) ?u64 {
        var current = self.findLink(id) orelse return null;
        var hops: usize = 0;
        while (current.parent_id) |parent| : (hops += 1) {
            if (hops >= self.links.items.len) return null;
            current = self.findLink(parent) orelse return null;
        }
        return current.id;
    }

    fn endOfFamily(self: *const Session, root_id: u64) usize {
        const start = self.indexOf(root_id).?;
        var index = start + 1;
        while (index < self.links.items.len and self.belongsToRoot(self.links.items[index].id, root_id)) : (index += 1) {}
        return index;
    }

    fn endOfSubtree(self: *const Session, ancestor_id: u64) usize {
        const start = self.indexOf(ancestor_id).?;
        var index = start + 1;
        while (index < self.links.items.len and self.isDescendantOf(self.links.items[index].id, ancestor_id)) : (index += 1) {}
        return index;
    }

    fn isDescendantOf(self: *const Session, id: u64, ancestor_id: u64) bool {
        var current = self.findLink(id) orelse return false;
        var hops: usize = 0;
        while (current.parent_id) |parent| : (hops += 1) {
            if (hops >= self.links.items.len) return false;
            if (parent == ancestor_id) return true;
            current = self.findLink(parent) orelse return false;
        }
        return false;
    }

    fn belongsToRoot(self: *const Session, id: u64, root_id: u64) bool {
        return (self.rootId(id) orelse return false) == root_id;
    }

    fn frontOfSection(self: *const Session, section_id: u64) usize {
        for (self.links.items, 0..) |link, index| if (link.section_id == section_id) return index;
        return self.links.items.len;
    }

    fn endOfSection(self: *const Session, section_id: u64) usize {
        var result = self.links.items.len;
        for (self.links.items, 0..) |link, index| {
            if (link.section_id == section_id) result = index + 1;
        }
        return result;
    }

    fn visualOrdinal(self: *const Session, id: u64) ?usize {
        var count: usize = 0;
        var section_id: u64 = 0;
        while (true) {
            for (self.links.items) |link| {
                if (link.section_id != section_id) continue;
                if (link.id == id) return count;
                count += 1;
            }
            if (section_id == 0) {
                if (self.sections.items.len == 0) break;
                section_id = self.sections.items[0].id;
                continue;
            }
            const index = self.sectionIndex(section_id).?;
            if (index + 1 == self.sections.items.len) break;
            section_id = self.sections.items[index + 1].id;
        }
        return null;
    }

    /// Returns the zero-based visual position used by keyboard shortcuts.
    pub fn linkAtVisualOrdinal(self: *const Session, wanted: usize) ?u64 {
        var count: usize = 0;
        var section_id: u64 = 0;
        while (true) {
            for (self.links.items) |link| {
                if (link.section_id != section_id) continue;
                if (count == wanted) return link.id;
                count += 1;
            }
            if (section_id == 0) {
                if (self.sections.items.len == 0) break;
                section_id = self.sections.items[0].id;
                continue;
            }
            const index = self.sectionIndex(section_id).?;
            if (index + 1 == self.sections.items.len) break;
            section_id = self.sections.items[index + 1].id;
        }
        return null;
    }
};

fn freeLink(allocator: std.mem.Allocator, link: Link) void {
    if (link.url.len != 0) allocator.free(link.url);
    if (link.title.len != 0) allocator.free(link.title);
}

fn containsId(ids: []const u64, wanted: u64) bool {
    for (ids) |id| if (id == wanted) return true;
    return false;
}

fn cloneLink(allocator: std.mem.Allocator, link: Link) !Link {
    const url = try allocator.dupe(u8, link.url);
    errdefer allocator.free(url);
    return .{
        .id = link.id,
        .url = url,
        .title = try allocator.dupe(u8, link.title),
        .section_id = link.section_id,
        .parent_id = link.parent_id,
        .unread = link.unread,
    };
}

fn validateText(value: []const u8, limit: usize) !void {
    if (value.len == 0 or value.len > limit or std.mem.trim(u8, value, " \t\r\n").len == 0) return error.InvalidText;
}

fn validateUrl(url: []const u8) !void {
    if (url.len == 0 or url.len > max_url_length or std.mem.indexOfAny(u8, url, " \t\r\n") != null) return error.InvalidUrl;
    const prefix = if (std.mem.startsWith(u8, url, "https://")) "https://" else if (std.mem.startsWith(u8, url, "http://")) "http://" else return error.InvalidUrl;
    const authority_end = std.mem.indexOfAnyPos(u8, url, prefix.len, "/?#") orelse url.len;
    const authority = url[prefix.len..authority_end];
    if (authority.len == 0 or std.mem.indexOfScalar(u8, authority, '@') != null) return error.InvalidUrl;
    const parsed = std.Uri.parse(url) catch return error.InvalidUrl;
    const component = parsed.host orelse return error.InvalidUrl;
    const host = switch (component) {
        .raw => |v| v,
        .percent_encoded => |v| v,
    };
    if (std.mem.eql(u8, prefix, "http://") and !std.ascii.eqlIgnoreCase(host, "localhost") and !std.mem.eql(u8, host, "127.0.0.1") and !std.mem.eql(u8, host, "[::1]") and !std.mem.eql(u8, host, "::1")) return error.InvalidUrl;
}

fn validatePersistedLink(session: *const Session, link: Link) !void {
    if (link.id == 0 or session.hasAnyId(link.id) or !session.hasSection(link.section_id)) return error.InvalidSnapshot;
    validateUrl(link.url) catch return error.InvalidSnapshot;
    validateText(link.title, max_title_length) catch return error.InvalidSnapshot;
    if (link.parent_id) |parent| {
        const parent_link = session.findLink(parent) orelse return error.InvalidSnapshot;
        if (parent_link.section_id != link.section_id) return error.InvalidSnapshot;
    }
}

fn validateClosedLink(session: *const Session, batch: *const ClosedBatch, link: Link) !void {
    if (link.id == 0) return error.InvalidSnapshot;
    validateUrl(link.url) catch return error.InvalidSnapshot;
    validateText(link.title, max_title_length) catch return error.InvalidSnapshot;
    if (link.parent_id) |parent| {
        if (session.findLink(parent) == null) {
            var found = false;
            for (batch.links.items) |earlier| {
                if (earlier.id == parent) found = true;
            }
            if (!found) return error.InvalidSnapshot;
        }
    }
}

test "moves a family across sections and keeps its parent association" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const root = try session.open("https://one.example/a", "A", null);
    const child = try session.open("https://one.example/b", "B", root);
    const section = try session.createSection("Saved");
    try session.moveLink(child, section, null);
    try std.testing.expectEqual(@as(usize, 2), session.links.items.len);
    try std.testing.expectEqual(section, session.links.items[0].section_id);
    try std.testing.expectEqual(root, session.links.items[1].parent_id.?);
}

test "moves a family before another root in the same section" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const first = try session.open("https://one.example/a", "A", null);
    _ = try session.open("https://one.example/b", "B", first);
    const second = try session.open("https://two.example", "two", null);
    try session.moveLink(first, 0, second);
    try std.testing.expectEqual(first, session.links.items[0].id);
    try std.testing.expectEqual(second, session.links.items[2].id);
}

test "inbox can collapse but cannot close and reopen leaves later links" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const first = try session.open("https://one.example", "one", null);
    try session.toggleSection(0);
    try std.testing.expect(session.getSection(0).?.collapsed);
    try std.testing.expectError(error.InboxImmutable, session.closeSection(0));
    const snapshot = try session.encodeJson(std.testing.allocator);
    defer std.testing.allocator.free(snapshot);
    var restored = try Session.decodeJson(std.testing.allocator, snapshot);
    defer restored.deinit();
    try std.testing.expect(restored.inbox_collapsed);
    try session.closeLink(first);
    const later = try session.open("https://two.example", "two", null);
    try session.reopen();
    try std.testing.expect(session.findLink(later) != null);
    try std.testing.expect(session.findLink(first) != null);
}

test "closing a child closes its subtree and reopening keeps the family contiguous" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const root = try session.open("https://one.example/root", "root", null);
    const child = try session.open("https://one.example/child", "child", root);
    const grandchild = try session.open("https://one.example/grandchild", "grandchild", child);
    try session.closeLink(child);
    try std.testing.expect(session.findLink(root) != null);
    try std.testing.expect(session.findLink(child) == null);
    try std.testing.expect(session.findLink(grandchild) == null);
    try session.reopen();
    try std.testing.expectEqual(root, session.links.items[0].id);
    try std.testing.expectEqual(child, session.links.items[1].id);
    try std.testing.expectEqual(grandchild, session.links.items[2].id);
}

test "cycle follows custom section order" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const first = try session.open("https://one.example", "one", null);
    const section_a = try session.createSection("A");
    const section_b = try session.createSection("B");
    try session.moveLink(first, section_a, null);
    const second = try session.open("https://two.example", "two", null);
    try session.moveLink(second, section_b, null);
    const inbox = try session.open("https://inbox.example", "inbox", null);
    try session.moveSection(section_b, section_a);
    try session.select(inbox);
    try std.testing.expectEqual(second, session.cycle(1).?);
}

test "deduplicated URL selects the existing link and section close restores its members" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const id = try session.open("https://one.example/a?x=1#part", "one", null);
    session.links.items[0].unread = true;
    try std.testing.expectEqual(id, try session.open("https://one.example/a?x=1#part", "other title", null));
    try std.testing.expect(!session.links.items[0].unread);

    const section = try session.createSection("Saved");
    try session.moveLink(id, section, null);
    try session.closeSection(section);
    try std.testing.expect(session.findLink(id) == null);
    try session.reopen();
    try std.testing.expectEqual(section, session.findLink(id).?.section_id);
}

test "JSON restores state and rejects invalid URLs" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const id = try session.open("https://one.example/p#x", "one", null);
    const data = try session.encodeJson(std.testing.allocator);
    defer std.testing.allocator.free(data);
    var restored = try Session.decodeJson(std.testing.allocator, data);
    defer restored.deinit();
    try std.testing.expectEqual(id, restored.selected.?);
    try std.testing.expectError(error.InvalidSnapshot, Session.decodeJson(std.testing.allocator, "{\"next_id\":2,\"sections\":[],\"links\":[{\"id\":1,\"url\":\"file:///bad\",\"title\":\"x\",\"section_id\":0,\"parent_id\":null,\"unread\":false}],\"selected\":null,\"sidebar_visible\":true}"));
}

test "JSON keeps recently closed batches and rejects interleaved sections" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const id = try session.open("https://one.example", "one", null);
    try session.closeLink(id);
    const data = try session.encodeJson(std.testing.allocator);
    defer std.testing.allocator.free(data);
    var restored = try Session.decodeJson(std.testing.allocator, data);
    defer restored.deinit();
    try restored.reopen();
    try std.testing.expect(restored.getLink(id) != null);

    const interleaved =
        "{\"next_id\":6,\"sections\":[{\"id\":1,\"name\":\"A\",\"collapsed\":false},{\"id\":2,\"name\":\"B\",\"collapsed\":false}],\"links\":[" ++
        "{\"id\":3,\"url\":\"https://a.example\",\"title\":\"a\",\"section_id\":1,\"parent_id\":null,\"unread\":false}," ++
        "{\"id\":4,\"url\":\"https://b.example\",\"title\":\"b\",\"section_id\":2,\"parent_id\":null,\"unread\":false}," ++
        "{\"id\":5,\"url\":\"https://c.example\",\"title\":\"c\",\"section_id\":1,\"parent_id\":null,\"unread\":false}],\"selected\":null,\"sidebar_visible\":true,\"closed\":[]}";
    try std.testing.expectError(error.InvalidSnapshot, Session.decodeJson(std.testing.allocator, interleaved));
}

test "capacity, recently closed retry, and snapshot roundtrip" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();

    for (0..max_sections - 1) |_| _ = try session.createSection("Saved");
    try std.testing.expectEqual(@as(usize, max_sections - 1), session.sections.items.len);
    try std.testing.expectError(error.SectionLimitReached, session.createSection("One too many"));

    var closed_id: u64 = 0;
    for (0..max_links) |index| {
        var url_buffer: [64]u8 = undefined;
        const url = try std.fmt.bufPrint(&url_buffer, "https://load.example/{d}", .{index});
        const id = try session.open(url, "load", null);
        if (index == max_links / 2) closed_id = id;
    }
    try std.testing.expectError(error.LinkLimitReached, session.open("https://load.example/overflow", "overflow", null));

    try session.closeLink(closed_id);
    const filler = try session.open("https://load.example/filler", "filler", null);
    const snapshot = try session.encodeJson(std.testing.allocator);
    defer std.testing.allocator.free(snapshot);

    var restored = try Session.decodeJson(std.testing.allocator, snapshot);
    defer restored.deinit();
    try std.testing.expectEqual(@as(usize, max_links), restored.links.items.len);
    try std.testing.expectEqual(@as(usize, 1), restored.closed.items.len);
    try std.testing.expectError(error.LinkLimitReached, restored.reopen());
    try std.testing.expectEqual(@as(usize, 1), restored.closed.items.len);
    try std.testing.expectEqual(@as(usize, max_links), restored.links.items.len);
    try std.testing.expect(restored.getLink(closed_id) == null);
    try std.testing.expect(restored.getLink(filler) != null);
}

test "URL policy accepts web links and loopback but rejects unsafe schemes and remote HTTP" {
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    _ = try session.open("https://shelf.example/s/share#capability", "Shelf", null);
    _ = try session.open("http://localhost:4988/index.html", "Local", null);
    _ = try session.open("http://[::1]:4988/index.html", "IPv6", null);
    try std.testing.expectError(error.InvalidUrl, session.open("http://remote.example", "Remote", null));
    try std.testing.expectError(error.InvalidUrl, session.open("javascript:alert(1)", "Script", null));
    try std.testing.expectError(error.InvalidUrl, session.open("https://user:password@example.com", "Credentials", null));
}

test "old snapshots default Inbox to expanded" {
    var session = try Session.decodeJson(std.testing.allocator, "{\"version\":1,\"next_id\":1,\"sections\":[],\"links\":[],\"selected\":null,\"sidebar_visible\":true}");
    defer session.deinit();
    try std.testing.expect(!session.inbox_collapsed);
}

const FakePayloadCache = struct {
    const Entry = struct { id: u64, payload: Payload };

    allocator: std.mem.Allocator,
    entries: std.ArrayList(Entry) = .empty,
    fail_put: bool = false,
    fail_read: bool = false,

    fn deinit(self: *FakePayloadCache) void {
        for (self.entries.items) |entry| {
            self.allocator.free(entry.payload.url);
            self.allocator.free(entry.payload.title);
        }
        self.entries.deinit(self.allocator);
    }

    fn cache(self: *FakePayloadCache) PayloadCache {
        return .{
            .context = @ptrCast(self),
            .put = put,
            .read = read,
            .find_url = findUrl,
        };
    }

    fn from(context: *anyopaque) *FakePayloadCache {
        return @ptrCast(@alignCast(context));
    }

    fn put(context: *anyopaque, id: u64, url: []const u8, title: []const u8) !void {
        const self = from(context);
        if (self.fail_put) return error.FakePutFailed;
        const payload = Payload{
            .url = try self.allocator.dupe(u8, url),
            .title = try self.allocator.dupe(u8, title),
        };
        errdefer {
            self.allocator.free(payload.url);
            self.allocator.free(payload.title);
        }
        for (self.entries.items) |*entry| if (entry.id == id) {
            self.allocator.free(entry.payload.url);
            self.allocator.free(entry.payload.title);
            entry.payload = payload;
            return;
        };
        try self.entries.append(self.allocator, .{ .id = id, .payload = payload });
    }

    fn read(context: *anyopaque, allocator: std.mem.Allocator, id: u64) !Payload {
        const self = from(context);
        if (self.fail_read) return error.FakeReadFailed;
        for (self.entries.items) |entry| if (entry.id == id) {
            const url = try allocator.dupe(u8, entry.payload.url);
            errdefer allocator.free(url);
            return .{ .url = url, .title = try allocator.dupe(u8, entry.payload.title) };
        };
        return error.FakePayloadMissing;
    }

    fn findUrl(context: *anyopaque, url: []const u8) !?u64 {
        const self = from(context);
        if (self.fail_read) return error.FakeReadFailed;
        for (self.entries.items) |entry| if (std.mem.eql(u8, entry.payload.url, url)) return entry.id;
        return null;
    }
};

fn residentPayloadCount(session: *const Session) usize {
    var count: usize = 0;
    for (session.links.items) |link| {
        if (link.url.len != 0) count += 1;
    }
    for (session.closed.items) |batch| for (batch.links.items) |link| {
        if (link.url.len != 0) count += 1;
    };
    return count;
}

test "payload cache bounds resident payloads to the prepared page and selection" {
    var cache = FakePayloadCache{ .allocator = std.testing.allocator };
    defer cache.deinit();
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const first = try session.open("https://one.example", "one", null);
    const second = try session.open("https://two.example", "two", null);
    const third = try session.open("https://three.example", "three", null);
    try session.enablePayloadCache(cache.cache());
    try session.select(third);
    try session.preparePage(&.{first});
    try std.testing.expectEqual(@as(usize, 2), residentPayloadCount(&session));
    try session.closeLink(third);
    try session.preparePage(&.{first});
    try std.testing.expectEqual(@as(usize, 1), residentPayloadCount(&session));
    try std.testing.expectEqual(@as(usize, 3), cache.entries.items.len);
    try std.testing.expect(session.findLink(second) != null);
}

test "cold payloads support reads, dedupe, moves, close, and reopen" {
    var cache = FakePayloadCache{ .allocator = std.testing.allocator };
    defer cache.deinit();
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const first = try session.open("https://one.example", "one", null);
    const second = try session.open("https://two.example", "two", null);
    const section = try session.createSection("Saved");
    try session.enablePayloadCache(cache.cache());
    try session.select(second);
    try session.preparePage(&.{second});
    try std.testing.expectEqual(@as(usize, 0), session.findLink(first).?.url.len);
    try std.testing.expectEqualStrings("one", session.getLink(first).?.title);
    try session.select(second);
    try session.preparePage(&.{second});
    try std.testing.expectEqual(first, try session.open("https://one.example", "other", null));
    try session.moveLink(first, section, null);
    try session.closeLink(first);
    try session.preparePage(&.{});
    try std.testing.expectEqual(@as(usize, 0), session.links.items[0].url.len);
    try std.testing.expectEqual(@as(usize, 0), session.closed.items[0].links.items[0].url.len);
    try session.reopen();
    try std.testing.expectEqual(section, session.getLink(first).?.section_id);
    try std.testing.expectEqualStrings("https://one.example", session.getLink(first).?.url);
}

test "encoding cold payloads preserves full snapshots without hydrating the model" {
    var cache = FakePayloadCache{ .allocator = std.testing.allocator };
    defer cache.deinit();
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const first = try session.open("https://one.example", "one", null);
    const second = try session.open("https://two.example", "two", null);
    try session.enablePayloadCache(cache.cache());
    try session.select(second);
    try session.preparePage(&.{second});
    try session.closeLink(first);
    const snapshot = try session.encodeJson(std.testing.allocator);
    defer std.testing.allocator.free(snapshot);
    try std.testing.expectEqual(@as(usize, 0), session.closed.items[0].links.items[0].url.len);
    var restored = try Session.decodeJson(std.testing.allocator, snapshot);
    defer restored.deinit();
    try restored.reopen();
    try std.testing.expectEqualStrings("https://one.example", restored.getLink(first).?.url);
    try std.testing.expectEqualStrings("one", restored.getLink(first).?.title);
}

test "failed cache seed and read leave existing session data intact" {
    var cache = FakePayloadCache{ .allocator = std.testing.allocator, .fail_put = true };
    defer cache.deinit();
    var session = Session.init(std.testing.allocator);
    defer session.deinit();
    const first = try session.open("https://one.example", "one", null);
    try std.testing.expectError(error.FakePutFailed, session.enablePayloadCache(cache.cache()));
    try std.testing.expect(session.payload_cache == null);
    try std.testing.expectEqualStrings("https://one.example", session.getLink(first).?.url);

    cache.fail_put = false;
    try session.enablePayloadCache(cache.cache());
    const second = try session.open("https://two.example", "two", null);
    try session.select(second);
    try session.preparePage(&.{second});
    cache.fail_read = true;
    try std.testing.expect(session.getLink(first) == null);
    try std.testing.expect(session.findLink(first) != null);
    try std.testing.expectEqual(@as(usize, 0), session.findLink(first).?.url.len);
    try std.testing.expectError(error.FakeReadFailed, session.updateTitle(first, "changed"));
}
