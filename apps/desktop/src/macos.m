#import "macos.h"

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

// Eight retained views bound native memory while preserving recent page state.
static const NSUInteger ShelfViewerCacheLimit = 8;
static void (*shelfEventCallback)(void);
static id shelfKeyMonitor;

@interface ShelfViewerEntry : NSObject
@property(nonatomic, copy) NSString *originalURL;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) WKNavigation *pendingNavigation;
@property(nonatomic, strong) WKBackForwardListItem *rootHistoryItem;
@property(nonatomic, strong) NSLayoutConstraint *sidebarConstraint;
@property(nonatomic, strong) NSLayoutConstraint *topConstraint;
@property(nonatomic) BOOL observingTitle;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) BOOL failed;
@end
@implementation ShelfViewerEntry
@end

@interface ShelfHost : NSObject <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, strong) ShelfViewerEntry *activeEntry;
@property(nonatomic, strong) NSMutableDictionary<NSString *, ShelfViewerEntry *> *viewerCache;
@property(nonatomic, strong) NSMutableArray<NSString *> *viewerRecency;
@property(nonatomic, strong) NSMutableArray<NSData *> *events;
@end

@implementation ShelfHost

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _events = [NSMutableArray array];
    _viewerCache = [NSMutableDictionary dictionary];
    _viewerRecency = [NSMutableArray array];
  }
  return self;
}

- (void)enqueueKind:(NSString *)kind url:(NSString *)url title:(NSString *)title message:(NSString *)message source:(NSString *)source {
  NSMutableDictionary *event = [@{ @"kind": kind } mutableCopy];
  if (url.length > 0) event[@"url"] = url;
  if (title.length > 0) event[@"title"] = title;
  if (message.length > 0) event[@"message"] = message;
  if (source.length > 0) event[@"source"] = source;
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (data != nil) {
    [self.events addObject:data];
    dispatch_async(dispatch_get_main_queue(), ^{ if (shelfEventCallback) shelfEventCallback(); });
  }
}

- (void)enqueueKind:(NSString *)kind url:(NSString *)url title:(NSString *)title message:(NSString *)message {
  [self enqueueKind:kind url:url title:title message:message source:self.activeEntry.originalURL];
}

- (NSWindow *)mainShelfWindow {
  NSWindow *window = NSApp.mainWindow;
  if ([window.title isEqualToString:@"Shelf"] && window.contentView != nil) return window;
  for (NSWindow *candidate in NSApp.orderedWindows) {
    if ([candidate.title isEqualToString:@"Shelf"] && candidate.contentView != nil &&
        !(candidate.styleMask & NSWindowStyleMaskUtilityWindow)) return candidate;
  }
  return nil;
}

- (BOOL)isAllowedURL:(NSURL *)url {
  NSString *scheme = url.scheme.lowercaseString;
  if ([scheme isEqualToString:@"https"]) return YES;
  if (![scheme isEqualToString:@"http"]) return NO;
  NSString *host = url.host.lowercaseString;
  return [host isEqualToString:@"localhost"] || [host isEqualToString:@"127.0.0.1"] || [host isEqualToString:@"::1"];
}

- (ShelfViewerEntry *)entryForWebView:(WKWebView *)webView {
  for (ShelfViewerEntry *entry in self.viewerCache.allValues) if (entry.webView == webView) return entry;
  return nil;
}

- (ShelfViewerEntry *)entryForController:(WKUserContentController *)controller {
  for (ShelfViewerEntry *entry in self.viewerCache.allValues) {
    if (entry.webView.configuration.userContentController == controller) return entry;
  }
  return nil;
}

- (void)touchEntry:(ShelfViewerEntry *)entry {
  [self.viewerRecency removeObject:entry.originalURL];
  [self.viewerRecency addObject:entry.originalURL];
}

- (void)detachEntry:(ShelfViewerEntry *)entry {
  if (entry == nil) return;
  [entry.webView removeFromSuperview];
  entry.sidebarConstraint = nil;
  entry.topConstraint = nil;
}

- (void)disposeEntry:(ShelfViewerEntry *)entry {
  if (entry == nil) return;
  [entry.webView stopLoading];
  if (entry.observingTitle) {
    [entry.webView removeObserver:self forKeyPath:@"title"];
    entry.observingTitle = NO;
  }
  [entry.webView.configuration.userContentController removeScriptMessageHandlerForName:@"shelfIndex" contentWorld:[WKContentWorld worldWithName:@"ShelfIndex"]];
  entry.webView.navigationDelegate = nil;
  entry.webView.UIDelegate = nil;
  [self detachEntry:entry];
  entry.pendingNavigation = nil;
  entry.webView = nil;
}

- (void)trimViewerCache {
  while (self.viewerRecency.count > ShelfViewerCacheLimit) {
    NSString *url = self.viewerRecency.firstObject;
    ShelfViewerEntry *entry = self.viewerCache[url];
    [self.viewerRecency removeObjectAtIndex:0];
    [self.viewerCache removeObjectForKey:url];
    [self disposeEntry:entry];
  }
}

- (ShelfViewerEntry *)createEntryForURL:(NSString *)url {
  ShelfViewerEntry *entry = [[ShelfViewerEntry alloc] init];
  entry.originalURL = url;
  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  [configuration.userContentController addScriptMessageHandler:self contentWorld:[WKContentWorld worldWithName:@"ShelfIndex"] name:@"shelfIndex"];
  entry.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
  entry.webView.navigationDelegate = self;
  entry.webView.UIDelegate = self;
  entry.webView.translatesAutoresizingMaskIntoConstraints = NO;
  [entry.webView setValue:@NO forKey:@"drawsBackground"];
  [entry.webView addObserver:self forKeyPath:@"title" options:NSKeyValueObservingOptionNew context:NULL];
  entry.observingTitle = YES;
  self.viewerCache[url] = entry;
  [self touchEntry:entry];
  [self trimViewerCache];
  return entry;
}

- (void)attachEntry:(ShelfViewerEntry *)entry sidebarWidth:(CGFloat)sidebarWidth {
  NSWindow *target = [self mainShelfWindow];
  if (target == nil) return;
  if (self.window != target) {
    [self detachEntry:self.activeEntry];
    self.window = target;
  }
  NSView *contentView = target.contentView;
  if (entry.webView.superview != contentView) {
    [self detachEntry:entry];
    [contentView addSubview:entry.webView];
    entry.sidebarConstraint = [entry.webView.leadingAnchor constraintEqualToAnchor:contentView.leadingAnchor constant:sidebarWidth];
    entry.topConstraint = [entry.webView.topAnchor constraintEqualToAnchor:contentView.topAnchor constant:sidebarWidth == 0 ? 48 : 0];
    [NSLayoutConstraint activateConstraints:@[
      entry.sidebarConstraint,
      [entry.webView.trailingAnchor constraintEqualToAnchor:contentView.trailingAnchor],
      entry.topConstraint,
      [entry.webView.bottomAnchor constraintEqualToAnchor:contentView.bottomAnchor],
    ]];
  } else {
    entry.sidebarConstraint.constant = sidebarWidth;
    entry.topConstraint.constant = sidebarWidth == 0 ? 48 : 0;
  }
  entry.webView.hidden = NO;
  if (contentView.subviews.lastObject != entry.webView) [contentView addSubview:entry.webView positioned:NSWindowAbove relativeTo:nil];
  [contentView layoutSubtreeIfNeeded];
}

- (void)startLoadForEntry:(ShelfViewerEntry *)entry URL:(NSURL *)url {
  entry.generation += 1;
  entry.failed = NO;
  WKUserContentController *controller = entry.webView.configuration.userContentController;
  [controller removeAllUserScripts];
  NSString *script = [NSString stringWithFormat:@"setTimeout(() => { window.webkit.messageHandlers.shelfIndex.postMessage({generation:%lu,text:(document.body?.innerText || '').slice(0,32768)}); }, 1000);", (unsigned long)entry.generation];
  [controller addUserScript:[[WKUserScript alloc] initWithSource:script injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:NO inContentWorld:[WKContentWorld worldWithName:@"ShelfIndex"]]];
  entry.rootHistoryItem = nil;
  [entry.webView stopLoading];
  entry.pendingNavigation = [entry.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (void)updateURL:(const char *)rawURL sidebarWidth:(double)sidebarWidth hidden:(int)hidden {
  NSString *value = rawURL == NULL ? nil : [NSString stringWithUTF8String:rawURL];
  if (value.length == 0 || (hidden & 1) != 0) {
    WKWebView *web = self.activeEntry.webView;
    if (!web.hidden && [self.window.firstResponder isKindOfClass:NSView.class] && [(NSView *)self.window.firstResponder isDescendantOf:web]) {
      for (NSView *view in self.window.contentView.subviews) {
        if (view != web && [view acceptsFirstResponder]) { [self.window makeFirstResponder:view]; break; }
      }
    }
    web.hidden = YES;
    return;
  }
  // Scroll frames must not repeat URL parsing, cache mutation or Auto Layout.
  ShelfViewerEntry *current = self.activeEntry;
  if (current && [current.originalURL isEqualToString:value] && current.webView.hidden == ((hidden & 2) != 0) &&
      current.webView.superview == self.window.contentView &&
      current.sidebarConstraint.constant == MAX(0.0, sidebarWidth)) return;
  NSURL *url = [NSURL URLWithString:value];
  if (url == nil || ![self isAllowedURL:url]) {
    [self enqueueKind:@"error" url:value title:nil message:@"Shelf only opens HTTPS URLs and loopback HTTP URLs." source:value];
    self.activeEntry.webView.hidden = YES;
    return;
  }
  ShelfViewerEntry *entry = self.viewerCache[value];
  BOOL isNewEntry = entry == nil;
  if (isNewEntry) entry = [self createEntryForURL:value];
  BOOL changedEntry = self.activeEntry != entry;
  if (changedEntry) {
    self.activeEntry.webView.hidden = YES;
    [self detachEntry:self.activeEntry];
    self.activeEntry = entry;
  }
  [self touchEntry:entry];
  [self attachEntry:entry sidebarWidth:MAX(0.0, sidebarWidth)];
  entry.webView.hidden = (hidden & 2) != 0;
  if (isNewEntry) [self startLoadForEntry:entry URL:url];
  else if (changedEntry) {
    if (entry.failed) [self enqueueKind:@"error" url:nil title:nil message:@"The page could not load." source:entry.originalURL];
    else [self enqueueKind:entry.webView.loading ? @"navigate" : @"loaded" url:entry.webView.URL.absoluteString title:entry.webView.title message:nil source:entry.originalURL];
  }
}

- (void)closeURL:(const char *)rawURL {
  NSString *url = rawURL == NULL ? nil : [NSString stringWithUTF8String:rawURL];
  ShelfViewerEntry *entry = self.viewerCache[url];
  if (entry == nil) return;
  if (self.activeEntry == entry) self.activeEntry = nil;
  [self.viewerCache removeObjectForKey:url];
  [self.viewerRecency removeObject:url];
  [self disposeEntry:entry];
}

- (void)reloadActiveEntry {
  ShelfViewerEntry *entry = self.activeEntry;
  if (entry == nil) return;
  entry.failed = NO;
  if (entry.webView.URL != nil) {
    entry.pendingNavigation = [entry.webView reload];
    return;
  }
  NSURL *url = [NSURL URLWithString:entry.originalURL];
  if (url != nil) [self startLoadForEntry:entry URL:url];
}

- (void)focus {
  NSWindow *target = [self mainShelfWindow];
  if (target != nil) {
    [target makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    if (self.activeEntry.webView != nil && !self.activeEntry.webView.hidden) [target makeFirstResponder:self.activeEntry.webView];
  }
}

- (void)handleGetURLEvent:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)replyEvent {
  NSString *url = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
  NSURLComponents *components = [NSURLComponents componentsWithString:url];
  if ([components.scheme.lowercaseString isEqualToString:@"shelf"]) {
    url = nil;
    for (NSURLQueryItem *item in components.queryItems) if ([item.name isEqualToString:@"url"]) { url = item.value; break; }
  }
  if (url.length > 0 && [self isAllowedURL:[NSURL URLWithString:url]]) [self enqueueKind:@"open" url:url title:nil message:nil source:nil];
  else [self enqueueKind:@"error" url:nil title:nil message:@"This link is not a supported web URL." source:nil];
  [self focus];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  ShelfViewerEntry *entry = [self entryForWebView:webView];
  if (entry == nil) { decisionHandler(WKNavigationActionPolicyCancel); return; }
  NSURL *url = action.request.URL;
  NSString *absoluteURL = url.absoluteString;
  if (![action.targetFrame isMainFrame]) {
    if (action.targetFrame == nil && absoluteURL.length > 0) {
      if ([self isAllowedURL:url]) [self enqueueKind:@"related" url:absoluteURL title:nil message:entry.originalURL source:entry.originalURL];
      else [self enqueueKind:@"error" url:absoluteURL title:nil message:@"Shelf blocked a non-web related URL." source:entry.originalURL];
      decisionHandler(WKNavigationActionPolicyCancel);
      return;
    }
    decisionHandler(WKNavigationActionPolicyAllow);
    return;
  }
  if (![self isAllowedURL:url]) {
    [self enqueueKind:@"error" url:absoluteURL title:nil message:@"Shelf blocked a non-web URL." source:entry.originalURL];
    decisionHandler(WKNavigationActionPolicyCancel);
    return;
  }
  if (action.navigationType == WKNavigationTypeLinkActivated) {
    NSURL *source = [NSURL URLWithString:entry.originalURL];
    if (![url.host.lowercaseString isEqualToString:source.host.lowercaseString]) {
      [self enqueueKind:@"related" url:absoluteURL title:nil message:nil source:entry.originalURL];
      decisionHandler(WKNavigationActionPolicyCancel);
      return;
    }
  }
  [self enqueueKind:@"navigate" url:absoluteURL title:nil message:nil source:entry.originalURL];
  decisionHandler(WKNavigationActionPolicyAllow);
}

- (nullable WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)windowFeatures {
  ShelfViewerEntry *entry = [self entryForWebView:webView];
  NSURL *url = action.request.URL;
  NSString *absoluteURL = url.absoluteString;
  if (absoluteURL.length > 0) {
    if ([self isAllowedURL:url]) [self enqueueKind:@"related" url:absoluteURL title:nil message:entry.originalURL source:entry.originalURL];
    else [self enqueueKind:@"error" url:absoluteURL title:nil message:@"Shelf blocked a non-web related URL." source:entry.originalURL];
  }
  return nil;
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  ShelfViewerEntry *entry = [self entryForWebView:webView];
  if (entry == nil || (entry.pendingNavigation && navigation != entry.pendingNavigation)) return;
  if (entry.rootHistoryItem == nil) entry.rootHistoryItem = webView.backForwardList.currentItem;
  entry.pendingNavigation = nil;
  entry.failed = NO;
  [self enqueueKind:@"loaded" url:webView.URL.absoluteString title:webView.title message:nil source:entry.originalURL];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  ShelfViewerEntry *entry = [self entryForWebView:webView];
  if (entry == nil || (entry.pendingNavigation && navigation != entry.pendingNavigation) || error.code == NSURLErrorCancelled) return;
  entry.pendingNavigation = nil;
  entry.failed = YES;
  [self enqueueKind:@"error" url:nil title:nil message:@"The page could not load. Check your connection and try again." source:entry.originalURL];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  ShelfViewerEntry *entry = [self entryForWebView:webView];
  if (entry == nil || (entry.pendingNavigation && navigation != entry.pendingNavigation) || error.code == NSURLErrorCancelled) return;
  entry.pendingNavigation = nil;
  entry.failed = YES;
  [self enqueueKind:@"error" url:nil title:nil message:@"The page could not load. Check your connection and try again." source:entry.originalURL];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary<NSKeyValueChangeKey, id> *)change context:(void *)context {
  if ([keyPath isEqualToString:@"title"] && [object isKindOfClass:WKWebView.class]) {
    ShelfViewerEntry *entry = [self entryForWebView:object];
    if (entry != nil) [self enqueueKind:@"title" url:entry.webView.URL.absoluteString title:entry.webView.title message:nil source:entry.originalURL];
    return;
  }
  [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  ShelfViewerEntry *entry = [self entryForController:controller];
  if (entry == nil || ![message.body isKindOfClass:NSDictionary.class]) return;
  NSDictionary *body = message.body;
  if (![body[@"generation"] isKindOfClass:NSNumber.class] || [body[@"generation"] unsignedIntegerValue] != entry.generation) return;
  NSString *text = body[@"text"];
  if (![text isKindOfClass:NSString.class] || text.length > 32768) return;
  NSDictionary *value = @{ @"kind": @"content", @"text": text, @"source": entry.originalURL };
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (data != nil) { [self.events addObject:data]; dispatch_async(dispatch_get_main_queue(), ^{ if (shelfEventCallback) shelfEventCallback(); }); }
}

- (void)shutdown {
  for (ShelfViewerEntry *entry in self.viewerCache.allValues) [self disposeEntry:entry];
  [self.viewerCache removeAllObjects];
  [self.viewerRecency removeAllObjects];
  self.activeEntry = nil;
  self.window = nil;
  [self.events removeAllObjects];
}
@end

static ShelfHost *ShelfHostShared(void) {
  static ShelfHost *host;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ host = [[ShelfHost alloc] init]; });
  return host;
}

void shelf_host_set_callback(void (*callback)(void)) {
  shelfEventCallback = callback;
  if (callback && ShelfHostShared().events.count) dispatch_async(dispatch_get_main_queue(), ^{ if (shelfEventCallback) shelfEventCallback(); });
}

void shelf_host_install(void) {
  shelfKeyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
    if ([NSApp.keyWindow.title isEqualToString:@"Shelf Commands"]) {
      NSString *command = event.keyCode == 53 ? @"dismiss" : event.keyCode == 125 ? @"next" : event.keyCode == 126 ? @"previous" : event.keyCode == 36 ? @"submit" : nil;
      if (command) { [ShelfHostShared() enqueueKind:@"command" url:nil title:command message:nil]; return nil; }
    }
    return event;
  }];
  ShelfHost *host = ShelfHostShared();
  [[NSAppleEventManager sharedAppleEventManager] setEventHandler:host andSelector:@selector(handleGetURLEvent:withReplyEvent:) forEventClass:kInternetEventClass andEventID:kAEGetURL];
}

void shelf_host_update(const char *url, double sidebar_width, int hidden) { [ShelfHostShared() updateURL:url sidebarWidth:sidebar_width hidden:hidden]; }
void shelf_host_close(const char *url) { [ShelfHostShared() closeURL:url]; }

size_t shelf_host_poll(char *json, size_t capacity) {
  ShelfHost *host = ShelfHostShared();
  NSData *event = host.events.firstObject;
  if (event == nil) return 0;
  size_t length = event.length;
  if (json == NULL || capacity <= length) {
    [host.events removeObjectAtIndex:0];
    const char *failure = "{\"kind\":\"error\",\"message\":\"URL event exceeds the app limit.\"}";
    length = strlen(failure);
    if (capacity <= length) return 0;
    memcpy(json, failure, length + 1);
    return length;
  }
  memcpy(json, event.bytes, length);
  json[length] = '\0';
  [host.events removeObjectAtIndex:0];
  return length;
}

void shelf_host_reload(void) { [ShelfHostShared() reloadActiveEntry]; }
void shelf_host_back(void) {
  ShelfViewerEntry *entry = ShelfHostShared().activeEntry;
  if (entry.webView.canGoBack && entry.webView.backForwardList.currentItem != entry.rootHistoryItem) [entry.webView goBack];
}
void shelf_host_forward(void) { WKWebView *webView = ShelfHostShared().activeEntry.webView; if (webView.canGoForward) [webView goForward]; }
void shelf_host_focus(void) { [ShelfHostShared() focus]; }

void shelf_host_copy(const char *text) {
  if (text == NULL) return;
  NSString *value = [NSString stringWithUTF8String:text];
  if (value == nil) return;
  NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
  [pasteboard clearContents];
  [pasteboard setString:value forType:NSPasteboardTypeString];
}

void shelf_host_palette(void) {
  ShelfHost *host = ShelfHostShared();
  NSWindow *main = [host mainShelfWindow];
  if (!main) return;
  for (NSWindow *palette in NSApp.windows) {
    if (![palette.title isEqualToString:@"Shelf Commands"]) continue;
    palette.hidesOnDeactivate = YES;
    palette.hasShadow = YES;
    palette.collectionBehavior |= NSWindowCollectionBehaviorFullScreenAuxiliary;
    if (palette.parentWindow != main) {
      [main addChildWindow:palette ordered:NSWindowAbove];
      NSRect frame = palette.frame;
      frame.origin.x = NSMidX(main.frame) - frame.size.width / 2;
      frame.origin.y = NSMaxY(main.frame) - frame.size.height - 100;
      [palette setFrame:frame display:YES];
    }
  }
}

void shelf_host_shutdown(void) {
  shelfEventCallback = NULL;
  if (shelfKeyMonitor) [NSEvent removeMonitor:shelfKeyMonitor];
  shelfKeyMonitor = nil;
  [[NSAppleEventManager sharedAppleEventManager] removeEventHandlerForEventClass:kInternetEventClass andEventID:kAEGetURL];
  [ShelfHostShared() shutdown];
}
