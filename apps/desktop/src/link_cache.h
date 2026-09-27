#ifndef SHELF_LINK_CACHE_H
#define SHELF_LINK_CACHE_H

#include <stddef.h>
#include <stdint.h>

int shelf_link_cache_open(void);
void shelf_link_cache_close(void);
int shelf_link_cache_put(uint64_t id, const char *url, const char *title);
size_t shelf_link_cache_read(uint64_t id, char *buffer, size_t capacity);
uint64_t shelf_link_cache_find_url(const char *url);
int shelf_link_cache_set_active(const uint64_t *ids, size_t count);
size_t shelf_link_cache_search(const char *query, uint64_t *ids, size_t capacity);
int shelf_link_cache_body(uint64_t id, const char *body);

#endif
