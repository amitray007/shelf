import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  parseStructuredSource,
  parseYamlSubset,
  StructuredDataPreview,
} from '../src/components/preview/structured-data-preview.js';

describe('structured data preview', () => {
  it('parses JSON and exposes the decoded value for tree rendering', () => {
    const result = parseStructuredSource('{"name":"Shelf","active":true,"items":[1,2]}', {
      fileName: 'artifact.json',
      mediaType: 'application/json',
    });

    expect(result).toEqual({
      format: 'json',
      ok: true,
      value: { active: true, items: [1, 2], name: 'Shelf' },
    });
  });

  it('keeps malformed JSON readable while reporting a parse error', () => {
    const source = '{"name": "Shelf",';
    const result = parseStructuredSource(source, { fileName: 'artifact.json' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('JSON');

    const markup = renderToStaticMarkup(
      <StructuredDataPreview fileName="artifact.json" source={source} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Source fallback');
    expect(markup).toContain('{&quot;name&quot;: &quot;Shelf&quot;,');
  });

  it('parses common YAML maps, sequences, flow values, and comments', () => {
    const value = parseYamlSubset(
      [
        'name: Shelf # inline comment',
        'features:',
        '  - previews',
        '  - sharing',
        'owner:',
        '  name: Amit',
        '  active: true',
        'limits: {rows: 250, mode: "bounded"}',
      ].join('\n'),
    );

    expect(value).toEqual({
      features: ['previews', 'sharing'],
      limits: { mode: 'bounded', rows: 250 },
      name: 'Shelf',
      owner: { active: true, name: 'Amit' },
    });
  });

  it('returns a useful YAML error for malformed indentation', () => {
    expect(() => parseYamlSubset('root:\n  child: one\n   broken: two')).toThrow('YAML line 3');
    const result = parseStructuredSource('root:\n  child: one\n   broken: two', {
      fileName: 'config.yaml',
      mediaType: 'application/yaml',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/line [23]/iu);
    expect(() => parseYamlSubset("name: 'Shelf")).toThrow('unterminated single-quoted scalar');
  });

  it('uses an injected YAML parser as-is, including a valid null document', () => {
    const result = parseStructuredSource('null', {
      fileName: 'null.yaml',
      yamlParser: () => null,
    });
    expect(result).toEqual({ format: 'yaml', ok: true, value: null });
    expect(() => parseYamlSubset('---\nfirst: one\n---\nsecond: two')).toThrow(
      'multiple documents',
    );
  });

  it('renders accessible Preview and Source tabs with filterable tree semantics', () => {
    const markup = renderToStaticMarkup(
      <StructuredDataPreview
        fileName="config.yaml"
        mediaType="text/yaml"
        source={'service:\n  name: shelf\n  replicas: 2'}
      />,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-label="Filter structured data"');
    expect(markup).toContain('aria-label="Structured data tree"');

    const sourceMarkup = renderToStaticMarkup(
      <StructuredDataPreview fileName="config.yaml" initialMode="source" source="name: shelf" />,
    );
    expect(sourceMarkup).toContain('aria-label="Artifact source"');
    expect(sourceMarkup).toContain('name: shelf');
  });

  it('can defer Preview and Source ownership to the outer file viewer', () => {
    const markup = renderToStaticMarkup(
      <StructuredDataPreview fileName="config.yaml" showModeTabs={false} source="name: shelf" />,
    );

    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain('Structured data tree');
  });
});
