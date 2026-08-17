import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  CLI_EXIT_CODES,
  ErrorEnvelopeSchema,
  exitCodeForError,
  isErrorEnvelope,
  isPublishResult,
  PublishResultSchema,
} from '../src/index.js';

describe('the versioned machine contract', () => {
  it('accepts the complete publish result and rejects undeclared response fields', () => {
    const result = {
      apiVersion: 'v1',
      workspaceId: 'ws_example',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
      contentHash: 'sha256:'.concat('a'.repeat(64)),
      byteCount: 12,
      provenance: {
        classification: 'direct-publish',
        observed: {
          actorId: 'actor_example',
          operation: 'file.publish',
        },
      },
      publisherMetadata: { source: 'agent' },
      requestId: 'req_CCCCCCCCCCCCCCCCCCCCCC',
      paths: {
        artifact: '/api/v1/artifacts/art_AAAAAAAAAAAAAAAAAAAAAA',
        revision: '/api/v1/revisions/rev_BBBBBBBBBBBBBBBBBBBBBB',
        content: '/api/v1/revisions/rev_BBBBBBBBBBBBBBBBBBBBBB/content',
      },
      replayed: false,
    };

    expect(Check(PublishResultSchema, result)).toBe(true);
    expect(isPublishResult(result)).toBe(true);
    expect(Check(PublishResultSchema, { ...result, storagePath: '/tmp/secret' })).toBe(false);
    expect(isPublishResult({ ...result, revisionId: 'not-opaque' })).toBe(false);
  });

  it('keeps error envelopes and CLI exit classes stable', () => {
    const envelope = {
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used for a different request.',
        retryable: false,
        requestId: 'req_CCCCCCCCCCCCCCCCCCCCCC',
        details: [{ field: 'idempotencyKey', reason: 'conflict' }],
      },
    };

    expect(Check(ErrorEnvelopeSchema, envelope)).toBe(true);
    expect(isErrorEnvelope(envelope)).toBe(true);
    expect(isErrorEnvelope({ error: { ...envelope.error, code: 'NOT_CANONICAL' } })).toBe(false);
    expect(exitCodeForError('IDEMPOTENCY_CONFLICT')).toBe(CLI_EXIT_CODES.validation);
    expect(exitCodeForError('ARTIFACT_NOT_FOUND')).toBe(CLI_EXIT_CODES.validation);
    expect(exitCodeForError('REVISION_NOT_FOUND')).toBe(CLI_EXIT_CODES.validation);
    expect(exitCodeForError('RANGE_NOT_SATISFIABLE')).toBe(CLI_EXIT_CODES.validation);
    expect(exitCodeForError('MULTI_RANGE_UNSUPPORTED')).toBe(CLI_EXIT_CODES.validation);
    expect(exitCodeForError('SERVICE_UNAVAILABLE')).toBe(CLI_EXIT_CODES.transient);
    expect(exitCodeForError('INTERNAL_ERROR')).toBe(CLI_EXIT_CODES.unexpected);
  });
});
