#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

static id paletteKeyMonitor;
static BOOL paletteOpen;
static void (*paletteKeyCallback)(unsigned char);

void shelf_shell_palette_open(int open) { paletteOpen = open != 0; }

void shelf_shell_keys_install(void (*callback)(unsigned char)) {
    if (paletteKeyMonitor) [NSEvent removeMonitor:paletteKeyMonitor];
    paletteKeyMonitor = nil;
    paletteKeyCallback = callback;
    if (!callback) return;
    paletteKeyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        NSEventModifierFlags modifiers = event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift);
        if (!paletteOpen || modifiers || ![NSApp.keyWindow.title isEqualToString:@"Shelf"] || (event.keyCode != 125 && event.keyCode != 126)) return event;
        // Leave IME candidate navigation to AppKit while composing text.
        id responder = NSApp.keyWindow.firstResponder;
        if ([responder conformsToProtocol:@protocol(NSTextInputClient)] && [responder hasMarkedText]) return event;
        unsigned char key = event.keyCode == 125 ? 1 : 2;
        dispatch_async(dispatch_get_main_queue(), ^{ if (paletteKeyCallback && paletteOpen) paletteKeyCallback(key); });
        return nil;
    }];
}

void shelf_shell_fullscreen(void) { [NSApp.mainWindow toggleFullScreen:nil]; }

// Load the installed bundle's icon directly, including after a local replacement.
const char *shelf_bundle_icon_path(void) {
    static NSString *path;
    path = [NSBundle.mainBundle pathForResource:@"AppIcon" ofType:@"icns"];
    return path.UTF8String ?: "";
}
