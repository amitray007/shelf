import type { ContentInventory, ContentReader, ContentStore } from '@shelf/core';

/** The complete content-storage interface consumed by Shelf application assembly. */
export interface ContentStorage extends ContentStore, ContentReader, ContentInventory {
  ready(): Promise<void>;
  close(): void;
}
