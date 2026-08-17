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
