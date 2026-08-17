import { randomBytes } from 'node:crypto';

import type { ContentByteRange, SealedContent, StagedContent } from '@shelf/core';

const CONTENT_ID_PATTERN = /^cnt_[a-f0-9]{32}$/u;
const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function createContentId(): string {
  return `cnt_${randomBytes(16).toString('hex')}`;
}

export function assertContentId(value: string): void {
  if (!CONTENT_ID_PATTERN.test(value)) throw new Error('Invalid content identifier.');
}

export function assertStagedContent(staged: StagedContent): void {
  assertContentId(staged.stageId);
}

export function assertDescriptor(descriptor: { contentHash: string; byteCount: number }): void {
  if (!CONTENT_HASH_PATTERN.test(descriptor.contentHash)) {
    throw new Error('Invalid content hash.');
  }
  if (!Number.isSafeInteger(descriptor.byteCount) || descriptor.byteCount < 0) {
    throw new Error('Invalid content byte count.');
  }
}

export function assertSealedContent(content: SealedContent): void {
  assertContentId(content.contentId);
  assertDescriptor(content);
}

export function resolveContentRange(
  range: ContentByteRange | undefined,
  byteCount: number,
): ContentByteRange {
  const resolved = range ?? { start: 0, end: byteCount - 1 };
  if (
    !Number.isSafeInteger(resolved.start) ||
    !Number.isSafeInteger(resolved.end) ||
    resolved.start < 0 ||
    resolved.end < resolved.start ||
    resolved.end >= byteCount
  ) {
    throw new Error('Invalid content byte range.');
  }
  return resolved;
}
