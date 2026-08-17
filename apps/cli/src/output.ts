import {
  CLI_EXIT_CODES,
  type CliExitCode,
  type ErrorCode,
  type ErrorEnvelope,
  exitCodeForError,
} from '@shelf/contracts';

export type CanonicalErrorEnvelope = ErrorEnvelope;

export class CliFailure extends Error {
  readonly envelope: CanonicalErrorEnvelope;
  readonly exitCode: CliExitCode;

  constructor(envelope: CanonicalErrorEnvelope, exitCode: CliExitCode) {
    super(envelope.error.message);
    this.name = 'CliFailure';
    this.envelope = envelope;
    this.exitCode = exitCode;
  }
}

export class CliPartialFailure extends CliFailure {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly secrets: readonly string[];

  constructor(
    payload: Readonly<Record<string, unknown>>,
    cause: CliFailure,
    secrets: readonly string[],
  ) {
    super(cause.envelope, cause.exitCode);
    this.name = 'CliPartialFailure';
    this.payload = payload;
    this.secrets = secrets;
  }
}

export function redactValue(value: unknown, secrets: readonly (string | undefined)[]): unknown {
  const present = secrets.filter(
    (secret): secret is string => secret !== undefined && secret.length > 0,
  );
  if (typeof value === 'string') {
    return present.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, present));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, present)]),
    );
  }
  return value;
}

export function failure(
  code: ErrorCode,
  message: string,
  options: { exitCode?: CliExitCode; retryable?: boolean } = {},
): CliFailure {
  return new CliFailure(
    {
      error: {
        code,
        message,
        retryable: options.retryable ?? false,
        requestId: 'cli',
      },
    },
    options.exitCode ?? exitCodeForError(code),
  );
}

export function usageFailure(message: string): CliFailure {
  return failure('INVALID_REQUEST', message, { exitCode: CLI_EXIT_CODES.usage });
}

export function remoteFailure(envelope: CanonicalErrorEnvelope): CliFailure {
  return new CliFailure(envelope, exitCodeForError(envelope.error.code));
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function redactEnvelope(
  envelope: CanonicalErrorEnvelope,
  secret: string | undefined,
): CanonicalErrorEnvelope {
  if (secret === undefined || secret.length === 0) return envelope;
  const redact = (value: string) => value.replaceAll(secret, '[REDACTED]');
  return {
    error: {
      ...envelope.error,
      message: redact(envelope.error.message),
      ...(envelope.error.details === undefined
        ? {}
        : {
            details: envelope.error.details.map((detail) => ({
              ...detail,
              reason: redact(detail.reason),
            })),
          }),
    },
  };
}
