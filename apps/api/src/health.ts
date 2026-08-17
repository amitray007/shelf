import type { FastifyInstance } from 'fastify';

export interface ReadinessState {
  markStarted(): void;
  markStopping(): void;
  check(): Promise<boolean>;
}

export function createReadinessState(checkDependencies: () => Promise<void>): ReadinessState {
  let serving = false;
  let pendingCheck: Promise<boolean> | undefined;
  return {
    markStarted() {
      serving = true;
    },
    markStopping() {
      serving = false;
    },
    async check() {
      if (!serving) return false;
      pendingCheck ??= checkDependencies()
        .then(() => serving)
        .catch(() => false)
        .finally(() => {
          pendingCheck = undefined;
        });
      return pendingCheck;
    },
  };
}

export function registerHealthRoutes(app: FastifyInstance, readiness: ReadinessState): void {
  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { hide: true } }, async (_request, reply) => {
    if (!(await readiness.check())) return reply.status(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });
}
