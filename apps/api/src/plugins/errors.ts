import type { ErrorCode, ErrorDetail } from '@shelf/contracts';
import { ShelfCoreError } from '@shelf/core';
import type { FastifyError, FastifyInstance } from 'fastify';

export class AuthenticationRequiredError extends ShelfCoreError {
  constructor() {
    super('AUTHENTICATION_REQUIRED', 'Authentication is required.', { retryable: false });
  }
}

function statusFor(code: ErrorCode): number {
  switch (code) {
    case 'AUTHENTICATION_REQUIRED':
      return 401;
    case 'AUTHORIZATION_DENIED':
      return 403;
    case 'INVALID_REQUEST':
      return 400;
    case 'IDEMPOTENCY_CONFLICT':
    case 'WORKSPACE_ALREADY_EXISTS':
      return 409;
    case 'ARTIFACT_NOT_FOUND':
    case 'REVISION_NOT_FOUND':
    case 'SHARE_NOT_FOUND':
    case 'ACCESS_CREDENTIAL_NOT_FOUND':
      return 404;
    case 'ARTIFACT_RECOVERY_EXPIRED':
      return 410;
    case 'RANGE_NOT_SATISFIABLE':
    case 'MULTI_RANGE_UNSUPPORTED':
      return 416;
    case 'REQUEST_CANCELLED':
      return 499;
    case 'CONTENT_UNAVAILABLE':
    case 'SERVICE_UNAVAILABLE':
      return 503;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

function validationDetails(error: FastifyError): ErrorDetail[] | undefined {
  if (error.validation === undefined) return undefined;
  return error.validation.slice(0, 32).map((issue) => ({
    field:
      issue.instancePath.length > 0
        ? issue.instancePath.slice(1)
        : (issue.params.missingProperty?.toString() ?? 'request'),
    reason: issue.message ?? 'is invalid',
  }));
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ShelfCoreError, request, reply) => {
    let code: ErrorCode = 'INTERNAL_ERROR';
    let message = 'An internal error occurred.';
    let retryable = false;
    let details: ErrorDetail[] | undefined;

    if (error instanceof ShelfCoreError) {
      ({ code, message, retryable, details } = error);
    } else if (
      error.validation !== undefined ||
      (typeof error.code === 'string' && error.code.startsWith('FST_'))
    ) {
      code = 'INVALID_REQUEST';
      message = 'The request is invalid.';
      details = validationDetails(error);
    } else {
      request.log.error({ err: error }, 'Unhandled API error.');
    }

    const envelope = {
      error: {
        code,
        message,
        retryable,
        requestId: request.id,
        ...(details === undefined ? {} : { details }),
      },
    };
    void reply.status(statusFor(code)).send(envelope);
  });
}
