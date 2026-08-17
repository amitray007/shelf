import { EventEmitter } from 'node:events';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { requestCancellationSignal } from '../src/request-cancellation.js';

function boundary(options: { requestAborted?: boolean; responseDestroyed?: boolean } = {}) {
  const requestRaw = Object.assign(new EventEmitter(), {
    aborted: options.requestAborted ?? false,
  });
  const responseRaw = Object.assign(new EventEmitter(), {
    destroyed: options.responseDestroyed ?? false,
    writableFinished: false,
  });
  const framework = new AbortController();
  const request = { raw: requestRaw, signal: framework.signal } as unknown as FastifyRequest;
  const reply = { raw: responseRaw } as unknown as FastifyReply;
  return { request, reply, requestRaw, responseRaw, framework };
}

describe('renderer request cancellation', () => {
  it('honors a disconnect that happened before listeners were attached', () => {
    const fixture = boundary({ requestAborted: true });

    const signal = requestCancellationSignal(fixture.request, fixture.reply);

    expect(signal.aborted).toBe(true);
    expect(fixture.requestRaw.listenerCount('aborted')).toBe(0);
    expect(fixture.responseRaw.listenerCount('close')).toBe(0);
  });

  it('honors an already-destroyed unfinished response', () => {
    const fixture = boundary({ responseDestroyed: true });

    const signal = requestCancellationSignal(fixture.request, fixture.reply);

    expect(signal.aborted).toBe(true);
    expect(fixture.requestRaw.listenerCount('aborted')).toBe(0);
    expect(fixture.responseRaw.listenerCount('close')).toBe(0);
  });
});
