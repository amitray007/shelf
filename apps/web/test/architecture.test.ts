import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceText(directory: string, excluded = new Set<string>()): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (excluded.has(entryPath)) return '';
      if (entry.isDirectory()) return sourceText(entryPath, excluded);
      if (!/\.(css|ts|tsx)$/.test(entry.name)) return '';
      return readFile(entryPath, 'utf8');
    }),
  );
  return chunks.join('\n');
}

describe('anonymous viewer architecture', () => {
  it('keeps file renderer dispatch in one shared module', async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '../src');
    const canonical = await readFile(
      path.join(sourceRoot, 'components/artifact-file-view.tsx'),
      'utf8',
    );
    expect(canonical).toContain('export function ArtifactFileView');
    expect(canonical).toContain('StructuredDataPreview');
    expect(canonical).toContain('DelimitedTablePreview');
    expect(canonical).toContain('DocxPreview');
    expect(canonical).toContain('WorkbookPreview');

    for (const adapterPath of [
      'components/folder-browser.tsx',
      'dashboard/managed-artifact-content.tsx',
      'viewer-page.tsx',
    ]) {
      const adapter = await readFile(path.join(sourceRoot, adapterPath), 'utf8');
      expect(adapter).toContain('ArtifactFileView');
      expect(adapter).not.toMatch(
        /StructuredDataPreview|DelimitedTablePreview|DocxPreview|WorkbookPreview|PdfViewer|AudioPreview|VideoPreview/u,
      );
    }
  });

  it('has no server-layer imports or capability-leaking browser APIs', async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '../src');
    const persistencePath = path.join(sourceRoot, 'components/review/persistence.ts');
    const source = await sourceText(sourceRoot, new Set([persistencePath]));
    expect(source).not.toMatch(/@shelf\/(?:api|auth|core|postgres|storage)/);
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('srcDoc');
    expect(source).not.toContain('srcdoc');
    expect(source).not.toContain('console.');
  });

  it('keeps review persistence narrowly scoped', async () => {
    const persistence = await readFile(
      path.resolve(import.meta.dirname, '../src/components/review/persistence.ts'),
      'utf8',
    );
    expect(persistence).toContain('shelf:review-');
    expect(persistence).not.toMatch(/shelf:(?!review-)[A-Za-z0-9_-]+/);
    expect(persistence).not.toMatch(
      /@shelf\/(?:api|auth|core|postgres|storage)|capability|secret|protected.*token|session.*authority/i,
    );
    expect(persistence).toContain('shelf:review-read:');
    expect(persistence).toContain('markReviewThreadRead');
    expect(persistence).toContain('isReviewThreadRead');
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
      path.resolve(import.meta.dirname, '../src/viewer-page.tsx'),
      'utf8',
    );
    expect(source).toContain("authority.accessType === 'protected' ? 'post' : 'get'");
    expect(source).toContain("input.name = 'token'");
    expect(source).not.toContain("input.name = 'secret'");
    expect(source).toContain('form.remove()');
    expect(source).not.toContain('URL.createObjectURL');
  });
});
