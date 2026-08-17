export interface ReferencedContent {
  contentId: string;
  contentHash: string;
  byteCount: number;
  revisionCount: number;
}

export interface ReferencedContentInventory {
  listReferencedContent(installationId: string): Promise<ReferencedContent[]>;
}

export interface SealedContentInventoryEntry {
  contentId: string;
  byteCount: number;
  modifiedAt: Date;
}

export interface StagingContentInventoryEntry {
  stageId: string;
  modifiedAt: Date;
}

export interface ContentInventorySnapshot {
  sealed: SealedContentInventoryEntry[];
  staging: StagingContentInventoryEntry[];
  unrecognizedEntries: number;
}

export interface ContentInventory {
  inventory(): Promise<ContentInventorySnapshot>;
}
