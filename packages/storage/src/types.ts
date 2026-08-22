import type { ContentInventory, ContentReader, ContentStore } from '@shelf/core';

/** The complete content-storage interface consumed by Shelf application assembly. */
export interface ContentStorage extends ContentStore, ContentReader, ContentInventory {
  /** Permanently delete one sealed object. Missing objects are treated as already deleted. */
  deleteSealed(contentId: string): Promise<void>;
  ready(): Promise<void>;
  close(): void;
}
