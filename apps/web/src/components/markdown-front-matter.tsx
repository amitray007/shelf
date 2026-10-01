import { useMemo } from 'react';
import { isMap, isScalar, parseDocument } from 'yaml';

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

export function MarkdownFrontMatter({ source, format }: { source: string; format: string }) {
  const fields = useMemo(() => (format === 'yaml' ? yamlFields(source) : null), [source, format]);

  return (
    <details className="markdown-front-matter">
      <summary>Document details</summary>
      {fields === null ? (
        <pre className="markdown-front-matter-source">{source}</pre>
      ) : (
        <dl className="markdown-front-matter-fields">
          {fields.map(({ key, value }) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}
