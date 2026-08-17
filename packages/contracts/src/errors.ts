import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

export const ERROR_CODES = [
  'AUTHENTICATION_REQUIRED',
  'AUTHORIZATION_DENIED',
  'INVALID_REQUEST',
  'IDEMPOTENCY_CONFLICT',
  'REVISION_NOT_FOUND',
  'RANGE_NOT_SATISFIABLE',
  'MULTI_RANGE_UNSUPPORTED',
  'REQUEST_CANCELLED',
  'CONTENT_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = Type.Unsafe<ErrorCode>({
  $id: 'ErrorCode',
  type: 'string',
  enum: [...ERROR_CODES],
});

export const ErrorDetailSchema = Type.Object(
  {
    field: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    reason: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false, $id: 'ErrorDetail' },
);

export const ErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: ErrorCodeSchema,
        message: Type.String({ minLength: 1, maxLength: 512 }),
        retryable: Type.Boolean(),
        requestId: Type.String({ minLength: 1, maxLength: 128 }),
        details: Type.Optional(Type.Array(ErrorDetailSchema, { maxItems: 32 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: 'ErrorEnvelope' },
);

export type ErrorDetail = Static<typeof ErrorDetailSchema>;
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return Check(ErrorEnvelopeSchema, value);
}

export const CLI_EXIT_CODES = {
  success: 0,
  unexpected: 1,
  usage: 2,
  authentication: 3,
  authorization: 4,
  validation: 5,
  transient: 6,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export function exitCodeForError(code: ErrorCode): CliExitCode {
  switch (code) {
    case 'AUTHENTICATION_REQUIRED':
      return CLI_EXIT_CODES.authentication;
    case 'AUTHORIZATION_DENIED':
      return CLI_EXIT_CODES.authorization;
    case 'INVALID_REQUEST':
    case 'IDEMPOTENCY_CONFLICT':
    case 'REVISION_NOT_FOUND':
    case 'RANGE_NOT_SATISFIABLE':
    case 'MULTI_RANGE_UNSUPPORTED':
      return CLI_EXIT_CODES.validation;
    case 'REQUEST_CANCELLED':
    case 'CONTENT_UNAVAILABLE':
    case 'SERVICE_UNAVAILABLE':
      return CLI_EXIT_CODES.transient;
    case 'INTERNAL_ERROR':
      return CLI_EXIT_CODES.unexpected;
  }
}
