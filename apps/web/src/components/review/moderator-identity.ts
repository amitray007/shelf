import { readReviewValue, removeReviewValue, writeReviewValue } from './persistence.js';

const moderatorNameKey = 'shelf:review-moderator:v1' as const;

export function readModeratorDisplayName(): string {
  const value = readReviewValue(moderatorNameKey);
  if (value === null) return '';
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : '';
}

export function saveModeratorDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    removeReviewValue(moderatorNameKey);
    return '';
  }
  writeReviewValue(moderatorNameKey, trimmed);
  return trimmed;
}
