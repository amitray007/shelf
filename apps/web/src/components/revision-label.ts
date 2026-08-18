export function ordinal(value: number): string {
  const finalTwoDigits = value % 100;
  if (finalTwoDigits >= 11 && finalTwoDigits <= 13) return `${value}th`;

  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

export function revisionLabel(revisionNumber: number): string {
  return `Revision: ${ordinal(revisionNumber)}`;
}

export function revisionSourceName(revision: ArtifactRevision): string {
  return revision.kind === 'file' ? revision.originalFileName : revision.rootName;
}

import type { ArtifactRevision } from '@shelf/contracts';
