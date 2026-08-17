import { describe, expect, it } from 'vitest';

import { runShelfAdmin } from '../src/operator/cli.js';

function runtime() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      env: {},
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
      async readStdin() {
        return '';
      },
    },
  };
}

describe('shelf-admin command boundary', () => {
  it('returns one stable JSON error and no stdout for missing commands', async () => {
    const output = runtime();
    await expect(runShelfAdmin(['node', 'shelf-admin'], output.value)).resolves.toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(JSON.parse(output.stderr[0] ?? '')).toEqual({
      error: { code: 'ADMIN_FAILED', message: 'Shelf administration failed.' },
    });
  });

  it('does not accept a password value on argv or echo its canary', async () => {
    const output = runtime();
    const canary = 'password-canary-never-print';
    await runShelfAdmin(
      [
        'node',
        'shelf-admin',
        'owner',
        'bootstrap',
        '--email',
        'owner@example.test',
        '--name',
        'Owner',
        '--password',
        canary,
        '--grant',
        'workspace-main:file.publish',
      ],
      output.value,
    );
    expect(`${output.stdout.join('')} ${output.stderr.join('')}`).not.toContain(canary);
  });
});
