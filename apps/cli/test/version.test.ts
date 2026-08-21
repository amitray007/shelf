import { describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';
import { CLI_VERSION } from '../src/version.js';

describe('shelf --version', () => {
  it('prints the CLI version to stdout and exits successfully', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['node', 'shelf', '--version'], {
      env: {},
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(0);
    expect(stdout).toContain(CLI_VERSION);
    expect(stderr).toBe('');
  });

  it('reports the development marker for repository builds', () => {
    expect(CLI_VERSION).toBe('0.0.0-dev');
  });
});
