import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';
import { FOLDER_LIMITS, FolderEntrySchema, PortableFolderPathSchema } from './folders.js';
import { OpaqueArtifactIdSchema, OpaqueRevisionIdSchema } from './publish.js';

export const COMPARISON_LIMITS = Object.freeze({ pageSize: 100 });

const ContentHashSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const CursorSchema = Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]);

const ComparisonCommon = {
  apiVersion: Type.Literal('v1'),
  workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
  artifactId: OpaqueArtifactIdSchema,
};

export const FileComparisonRevisionSchema = Type.Object(
  {
    revisionId: OpaqueRevisionIdSchema,
    contentHash: ContentHashSchema,
    byteCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    originalFileName: Type.String({ minLength: 1, maxLength: 255 }),
    mediaType: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);

export const FileRevisionComparisonSchema = Type.Object(
  {
    ...ComparisonCommon,
    kind: Type.Literal('file'),
    base: FileComparisonRevisionSchema,
    target: FileComparisonRevisionSchema,
    status: Type.Union([Type.Literal('unchanged'), Type.Literal('changed')]),
    changes: Type.Object(
      {
        content: Type.Boolean(),
        mediaType: Type.Boolean(),
        originalFileName: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const FolderComparisonRevisionSchema = Type.Object(
  {
    revisionId: OpaqueRevisionIdSchema,
    contentHash: ContentHashSchema,
    byteCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    fileCount: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxFiles }),
    rootName: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);

const AddedFolderComparisonItemSchema = Type.Object(
  {
    status: Type.Literal('added'),
    path: PortableFolderPathSchema,
    after: FolderEntrySchema,
  },
  { additionalProperties: false },
);

const RemovedFolderComparisonItemSchema = Type.Object(
  {
    status: Type.Literal('removed'),
    path: PortableFolderPathSchema,
    before: FolderEntrySchema,
  },
  { additionalProperties: false },
);

const ChangedFolderComparisonItemSchema = Type.Object(
  {
    status: Type.Literal('changed'),
    path: PortableFolderPathSchema,
    before: FolderEntrySchema,
    after: FolderEntrySchema,
  },
  { additionalProperties: false },
);

const MovedFolderComparisonItemSchema = Type.Object(
  {
    status: Type.Literal('moved'),
    fromPath: PortableFolderPathSchema,
    toPath: PortableFolderPathSchema,
    before: FolderEntrySchema,
    after: FolderEntrySchema,
  },
  { additionalProperties: false },
);

export const FolderComparisonItemSchema = Type.Union([
  AddedFolderComparisonItemSchema,
  RemovedFolderComparisonItemSchema,
  ChangedFolderComparisonItemSchema,
  MovedFolderComparisonItemSchema,
]);

export const FolderRevisionComparisonSchema = Type.Object(
  {
    ...ComparisonCommon,
    kind: Type.Literal('folder'),
    base: FolderComparisonRevisionSchema,
    target: FolderComparisonRevisionSchema,
    summary: Type.Object(
      {
        added: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxEntries * 2 }),
        removed: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxEntries * 2 }),
        moved: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxEntries }),
        changed: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxEntries }),
        unchanged: Type.Integer({ minimum: 0, maximum: FOLDER_LIMITS.maxEntries }),
      },
      { additionalProperties: false },
    ),
    items: Type.Array(FolderComparisonItemSchema, { maxItems: COMPARISON_LIMITS.pageSize }),
    nextCursor: CursorSchema,
  },
  { additionalProperties: false },
);

export const RevisionComparisonSchema = Type.Union(
  [FileRevisionComparisonSchema, FolderRevisionComparisonSchema],
  { $id: 'RevisionComparison' },
);

export type FileRevisionComparison = Static<typeof FileRevisionComparisonSchema>;
export type FolderComparisonItem = Static<typeof FolderComparisonItemSchema>;
export type FolderRevisionComparison = Static<typeof FolderRevisionComparisonSchema>;
export type RevisionComparison = Static<typeof RevisionComparisonSchema>;

export function isRevisionComparison(value: unknown): value is RevisionComparison {
  return Check(RevisionComparisonSchema, value);
}
