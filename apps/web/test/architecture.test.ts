import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceText(entryPath);
      if (!/\.(css|ts|tsx)$/.test(entry.name)) return '';
      return readFile(entryPath, 'utf8');
    }),
  );
  return chunks.join('\n');
}

describe('anonymous viewer architecture', () => {
  it('has no server-layer imports or capability-leaking browser APIs', async () => {
    const source = await sourceText(path.resolve(import.meta.dirname, '../src'));
    expect(source).not.toMatch(/@shelf\/(?:api|auth|core|postgres|storage)/);
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('srcDoc');
    expect(source).not.toContain('srcdoc');
    expect(source).not.toContain('console.');
  });

  it('ships only a dark token branch and no theme switch', async () => {
    const source = await sourceText(path.resolve(import.meta.dirname, '../src'));
    expect(source).toContain('color-scheme: dark');
    expect(source).not.toMatch(/color-scheme:\s*light|prefers-color-scheme|theme-toggle/i);
    expect(source).not.toContain('linear-gradient');
    expect(source).not.toContain('radial-gradient');
  });

  it('navigates active HTML through a transient sandboxed POST target', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/components/renderer-frame.tsx'),
      'utf8',
    );
    expect(source).toContain("form.method = 'post'");
    expect(source).toContain('form.remove()');
    expect(source).toContain('sandbox="allow-scripts"');
    expect(source).not.toContain('allow-same-origin');
    expect(source).not.toContain('allow-forms');
    expect(source).not.toContain('actionPath:');
    expect(source).toContain("frame.src = 'about:blank'");
    expect(source).toContain('readyRef.current');
  });

  it('streams downloads through the access-type-specific anonymous route', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/components/artifact-content.tsx'),
      'utf8',
    );
    expect(source).toContain("authority.accessType === 'protected' ? 'post' : 'get'");
    expect(source).toContain("input.name = 'token'");
    expect(source).not.toContain("input.name = 'secret'");
    expect(source).toContain('form.remove()');
    expect(source).not.toContain('URL.createObjectURL');
  });
});
