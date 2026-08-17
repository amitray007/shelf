import type { ErrorCode, ErrorDetail } from '@shelf/contracts';

export class ShelfCoreError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: ErrorDetail[];

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable: boolean; details?: ErrorDetail[]; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ShelfCoreError';
    this.code = code;
    this.retryable = options.retryable;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function boundaryFailure(
  code: 'CONTENT_UNAVAILABLE' | 'SERVICE_UNAVAILABLE',
  message: string,
  cause: unknown,
): ShelfCoreError {
  if (cause instanceof ShelfCoreError) return cause;
  return new ShelfCoreError(code, message, { retryable: true, cause });
}
