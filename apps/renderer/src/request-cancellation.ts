import type { FastifyReply, FastifyRequest } from 'fastify';

function isHandlerTimeout(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    reason.code === 'FST_ERR_HANDLER_TIMEOUT'
  );
}

export function requestCancellationSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): AbortSignal {
  const controller = new AbortController();
  const frameworkSignal = request.signal;
  const cleanup = () => {
    request.raw.off('aborted', onRequestAborted);
    reply.raw.off('close', onResponseClose);
    reply.raw.off('finish', cleanup);
    frameworkSignal.removeEventListener('abort', onFrameworkAbort);
  };
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    cleanup();
  };
  const onRequestAborted = () => abort(new DOMException('Client disconnected.', 'AbortError'));
  const onResponseClose = () => {
    if (!reply.raw.writableFinished) {
      abort(new DOMException('Client disconnected.', 'AbortError'));
    }
  };
  const onFrameworkAbort = () => {
    if (request.raw.aborted || isHandlerTimeout(frameworkSignal.reason)) {
      abort(frameworkSignal.reason);
    }
  };

  request.raw.once('aborted', onRequestAborted);
  reply.raw.once('close', onResponseClose);
  reply.raw.once('finish', cleanup);
  frameworkSignal.addEventListener('abort', onFrameworkAbort, { once: true });
  if (request.raw.aborted) onRequestAborted();
  else if (frameworkSignal.aborted) onFrameworkAbort();
  else if (reply.raw.destroyed && !reply.raw.writableFinished) onResponseClose();
  return controller.signal;
}
