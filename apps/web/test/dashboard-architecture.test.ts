import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname, '../src');

describe('dashboard architecture', () => {
  it('keeps authenticated navigation to the two approved utilities', async () => {
    const source = await readFile(path.join(sourceRoot, 'dashboard/layout.tsx'), 'utf8');
    expect(source).toContain('Artifacts');
    expect(source).toContain('Access');
    expect(source).not.toMatch(/Collections|Activity|Analytics|Settings/);
  });

  it('routes sign-in, workspace artifacts, artifact detail, and access without a dashboard publish route', async () => {
    const source = await readFile(path.join(sourceRoot, 'main.tsx'), 'utf8');
    expect(source).toContain("path: '/signin'");
    expect(source).toContain("path: '/app'");
    expect(source).toContain("path: 'w/:workspaceId/artifacts'");
    expect(source).toContain("path: 'w/:workspaceId/artifacts/:artifactId'");
    expect(source).toContain("path: 'access'");
    expect(source).not.toMatch(/path:\s*['"][^'"]*publish/);
  });

  it('uses Base UI only for bounded overlays and never stores access secrets in browser storage', async () => {
    const dialogs = await readFile(path.join(sourceRoot, 'dashboard/dialogs.tsx'), 'utf8');
    const dashboardSource = await Promise.all(
      ['api.ts', 'dialogs.tsx', 'access-page.tsx', 'artifact-page.tsx'].map((file) =>
        readFile(path.join(sourceRoot, 'dashboard', file), 'utf8'),
      ),
    );
    expect(dialogs).toContain("from '@base-ui/react/dialog'");
    expect(dashboardSource.join('\n')).not.toMatch(/localStorage|sessionStorage|console\./);
  });

  it('retains a dark-only, reduced-motion interface contract', async () => {
    const styles = await readFile(path.join(sourceRoot, 'styles.css'), 'utf8');
    expect(styles).toContain('color-scheme: dark');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).not.toMatch(
      /color-scheme:\s*light|prefers-color-scheme|linear-gradient|radial-gradient/,
    );
  });

  it('provides route-level loading fallbacks instead of flashing an empty document', async () => {
    const source = await readFile(path.join(sourceRoot, 'main.tsx'), 'utf8');
    expect(source.match(/HydrateFallback:/gu)).toHaveLength(3);
  });
});
