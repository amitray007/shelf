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

  it('uses granular Kumo controls and never stores access secrets in browser storage', async () => {
    const dialogs = await readFile(path.join(sourceRoot, 'dashboard/dialogs.tsx'), 'utf8');
    const layout = await readFile(path.join(sourceRoot, 'dashboard/layout.tsx'), 'utf8');
    const dashboardSource = await Promise.all(
      ['api.ts', 'dialogs.tsx', 'access-page.tsx', 'artifact-page.tsx'].map((file) =>
        readFile(path.join(sourceRoot, 'dashboard', file), 'utf8'),
      ),
    );
    expect(dialogs).toContain("from '@cloudflare/kumo/components/dialog'");
    expect(dialogs).toContain("from '@cloudflare/kumo/components/clipboard-text'");
    expect(layout).toContain("from '@cloudflare/kumo/components/dropdown'");
    expect(`${dialogs}\n${layout}`).not.toContain("from '@cloudflare/kumo'");
    expect(`${dialogs}\n${layout}`).not.toContain("from '@base-ui/react");
    expect(dashboardSource.join('\n')).not.toMatch(/localStorage|sessionStorage|console\./);
  });

  it('composes Access as a responsive Kumo credential ledger', async () => {
    const access = await readFile(path.join(sourceRoot, 'dashboard/access-page.tsx'), 'utf8');
    const styles = await readFile(path.join(sourceRoot, 'dashboard/access.css'), 'utf8');

    expect(access).toContain("from '@cloudflare/kumo/components/banner'");
    expect(access).toContain("from '@cloudflare/kumo/components/button'");
    expect(access).toContain("from '@cloudflare/kumo/components/checkbox'");
    expect(access).toContain("from '@cloudflare/kumo/components/dropdown'");
    expect(access).toContain("from '@cloudflare/kumo/components/empty'");
    expect(access).toContain("from '@cloudflare/kumo/components/input'");
    expect(access).toContain("from '@cloudflare/kumo/components/table'");
    expect(access).toContain('<Table');
    expect(access).toContain('CredentialDetailsDialog');
    expect(access).toContain('<SecretReveal');
    expect(access).not.toMatch(/<(?:button|input)\b/);
    expect(access).not.toContain('eyebrow');
    expect(styles).toMatch(
      /\.credential-actions-trigger\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/su,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*680px\)[\s\S]*\.credential-table-shell\s*\{[^}]*display:\s*none/su,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*680px\)[\s\S]*\.credential-mobile-list\s*\{[^}]*display:\s*grid/su,
    );
  });

  it('keeps sign-in a restrained Kumo utility form', async () => {
    const source = await readFile(path.join(sourceRoot, 'dashboard/signin-page.tsx'), 'utf8');

    expect(source).toContain("from '@cloudflare/kumo/components/banner'");
    expect(source).toContain("from '@cloudflare/kumo/components/button'");
    expect(source).toContain("from '@cloudflare/kumo/components/input'");
    expect(source).toContain("from '@cloudflare/kumo/components/sensitive-input'");
    expect(source).not.toMatch(/<(?:button|input)\b/);
    expect(source).not.toContain('eyebrow');
    expect(source).not.toContain('Open your artifact shelf');
  });

  it('keeps Access and sign-out in the workspace menu without a mobile tab bar', async () => {
    const layout = await readFile(path.join(sourceRoot, 'dashboard/layout.tsx'), 'utf8');
    const shell = await readFile(path.join(sourceRoot, 'dashboard/shell.css'), 'utf8');
    const responsive = await readFile(path.join(sourceRoot, 'dashboard/responsive.css'), 'utf8');
    expect(layout).toContain('Workspace menu');
    expect(layout).toContain('Access');
    expect(layout).toContain('Sign out');
    expect(layout).not.toContain('dashboard-nav');
    expect(shell).toMatch(/\.dashboard-bar\s*\{[^}]*height:\s*48px/su);
    expect(responsive).not.toContain('.dashboard-nav');
  });

  it('retains a dark-only, reduced-motion interface contract', async () => {
    const styles = await readFile(path.join(sourceRoot, 'styles.css'), 'utf8');
    const source = await readFile(path.join(sourceRoot, 'main.tsx'), 'utf8');
    expect(styles).toContain('color-scheme: dark');
    expect(source).toContain("document.documentElement.dataset.mode = 'dark'");
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
