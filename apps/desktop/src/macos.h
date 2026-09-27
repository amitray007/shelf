#ifndef SHELF_DESKTOP_MACOS_H
#define SHELF_DESKTOP_MACOS_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif
void shelf_host_install(void);
void shelf_host_set_callback(void (*callback)(void));
void shelf_host_palette(void);
void shelf_host_update(const char *url, double sidebar_width, int hidden);
void shelf_host_close(const char *url);

// Returns the event byte length. Oversized events become a bounded error.
size_t shelf_host_poll(char *json, size_t capacity);

void shelf_host_reload(void);
void shelf_host_back(void);
void shelf_host_forward(void);
void shelf_host_focus(void);
void shelf_host_copy(const char *text);
void shelf_host_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif
