import { useMemo } from 'react';
import { isMap, isScalar, parseDocument } from 'yaml';
import { metadataLabel } from './viewer-controls.js';

function yamlFields(source: string) {
  try {
    // Read source ranges rather than expanding aliases or converting YAML values.
    const document = parseDocument(source, { schema: 'failsafe', prettyErrors: false });
    if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
      return null;
    }
    const fields: { key: string; value: string }[] = [];
    for (const { key, value } of document.contents.items) {
      if (!isScalar(key)) return null;
      fields.push({
        key: String(key.value),
        value: value?.range ? source.slice(value.range[0], value.range[1]).trimEnd() : '',
      });
    }
    return fields.length > 0 ? fields : null;
  } catch {
    return null;
  }
}

/** Read only a leading fenced block, matching the Markdown renderer's supported formats. */
export function extractMarkdownFrontMatter(
  source: string,
): { source: string; format: string } | null {
  const match = /^(?:\uFEFF)?(---|\+\+\+)[\t ]*\r?\n([\s\S]*?)\r?\n\1[\t ]*(?:\r?\n|$)/u.exec(
    source,
  );
  return match ? { source: match[2] ?? '', format: match[1] === '---' ? 'yaml' : 'toml' } : null;
}

export function MarkdownFrontMatter({
  source,
  format,
  panel = false,
}: {
  source: string;
  format: string;
  panel?: boolean;
}) {
  const fields = useMemo(() => (format === 'yaml' ? yamlFields(source) : null), [source, format]);
  const content =
    fields === null ? (
      <pre className="markdown-front-matter-source">{source}</pre>
    ) : (
      <dl className={panel ? 'viewer-metadata-list' : 'markdown-front-matter-fields'}>
        {fields.map(({ key, value }) => (
          <div key={key}>
            <dt title={panel ? key : undefined}>{panel ? metadataLabel(key) : key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    );
  return panel ? (
    <section aria-label="Document properties" className="viewer-details-section">
      <h3>Document properties</h3>
      <p>Properties written inside this file.</p>
      {content}
    </section>
  ) : (
    <details className="markdown-front-matter">
      <summary>Document details</summary>
      {content}
    </details>
  );
}
