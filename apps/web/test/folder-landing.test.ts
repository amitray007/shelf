import { describe, expect, it } from 'vitest';

import { folderLandingFile } from '../src/viewer-loader.js';

const file = (path: string, byteCount = 10) => ({
  path,
  kind: 'file' as const,
  mediaType: 'text/plain',
  contentHash: `sha256:${'a'.repeat(64)}`,
  byteCount,
});

describe('folder landing prefetch', () => {
  it('picks the file the folder browser opens first', () => {
    expect(folderLandingFile([file('app.js'), file('README.md'), file('index.html')])).toBe(
      'index.html',
    );
    expect(folderLandingFile([file('notes.txt'), file('README.md')])).toBe('README.md');
  });

  it('skips folders without a landing file and large landing files', () => {
    expect(folderLandingFile([file('app.js'), { path: 'docs', kind: 'directory' }])).toBe(
      undefined,
    );
    expect(folderLandingFile([file('index.html', 2 * 1024 * 1024)])).toBeUndefined();
  });
});
