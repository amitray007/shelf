import { BracketsCurlyIcon } from '@phosphor-icons/react/BracketsCurly';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/MagnifyingGlass';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { parse as parseYaml12 } from 'yaml';

import {
  ParseErrorNotice,
  type PreviewMode,
  PreviewModeTabs,
  PreviewPanel,
  SourcePane,
} from './preview-shared.js';

export type StructuredDataFormat = 'json' | 'yaml';

export type StructuredDataYamlParser = (source: string) => unknown;

export interface StructuredDataPreviewProps {
  readonly source: string;
  readonly fileName?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly initialMode?: PreviewMode | undefined;
  /** Hide the inner mode tabs when an outer file viewer owns Preview/Source. */
  readonly showModeTabs?: boolean | undefined;
  /** Hide the inner filename/format row when an outer share toolbar owns identity. */
  readonly showFileIdentity?: boolean | undefined;
  readonly yamlParser?: StructuredDataYamlParser | undefined;
  readonly maxNodes?: number | undefined;
  readonly maxSourceLength?: number | undefined;
}

export type StructuredParseResult =
  | { readonly ok: true; readonly format: StructuredDataFormat; readonly value: unknown }
  | { readonly error: string; readonly format: StructuredDataFormat; readonly ok: false };

const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_SOURCE_LENGTH = 2_000_000;

function sourceFormat(fileName = '', mediaType = ''): StructuredDataFormat {
  const normalizedMediaType = mediaType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (normalizedMediaType.includes('yaml') || /\.(?:ya?ml)$/iu.test(fileName)) return 'yaml';
  return 'json';
}

export function inferStructuredDataFormat(
  fileName?: string,
  mediaType?: string,
): StructuredDataFormat {
  return sourceFormat(fileName, mediaType);
}

function formatParseError(error: unknown, format: StructuredDataFormat): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return `The ${format.toUpperCase()} source could not be parsed.`;
}

export function parseStructuredSource(
  source: string,
  {
    fileName,
    mediaType,
    yamlParser,
    maxSourceLength = DEFAULT_MAX_SOURCE_LENGTH,
  }: {
    readonly fileName?: string | undefined;
    readonly mediaType?: string | undefined;
    readonly yamlParser?: StructuredDataYamlParser | undefined;
    readonly maxSourceLength?: number | undefined;
  } = {},
): StructuredParseResult {
  const format = sourceFormat(fileName, mediaType);
  if (source.length > maxSourceLength) {
    return {
      error: `Source is too large to inspect (limit ${maxSourceLength.toLocaleString()} characters).`,
      format,
      ok: false,
    };
  }
  try {
    return {
      format,
      ok: true,
      value: format === 'json' ? JSON.parse(source) : (yamlParser ?? parseYaml12)(source),
    };
  } catch (error) {
    return { error: formatParseError(error, format), format, ok: false };
  }
}

interface YamlLine {
  readonly indent: number;
  readonly lineNumber: number;
  readonly text: string;
}

class YamlSyntaxError extends Error {
  constructor(lineNumber: number, message: string) {
    super(`YAML line ${lineNumber}: ${message}`);
    this.name = 'YamlSyntaxError';
  }
}

function yamlError(line: YamlLine | undefined, message: string): never {
  throw new YamlSyntaxError(line?.lineNumber ?? 1, message);
}

function removeYamlComment(text: string): string {
  let quote: 'double' | 'single' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" && quote !== 'double') {
      if (quote === 'single' && text[index + 1] === "'") {
        index += 1;
      } else {
        quote = quote === 'single' ? null : 'single';
      }
    } else if (character === '"' && quote !== 'single' && text[index - 1] !== '\\') {
      quote = quote === 'double' ? null : 'double';
    } else if (
      character === '#' &&
      quote === null &&
      (index === 0 || /\s/u.test(text[index - 1] ?? ''))
    ) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function readYamlLines(source: string): YamlLine[] {
  const lines: YamlLine[] = [];
  let documentEnded = false;
  for (const [index, rawLine] of source
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .entries()) {
    const lineNumber = index + 1;
    if (/^\s*\t/u.test(rawLine))
      throw new YamlSyntaxError(lineNumber, 'tabs are not valid indentation');
    const indent = rawLine.match(/^ */u)?.[0].length ?? 0;
    const text = removeYamlComment(rawLine.slice(indent)).trim();
    if (text.length === 0) continue;
    if (documentEnded)
      yamlError({ indent, lineNumber, text }, 'multiple documents are not supported');
    if (text === '---') {
      if (lines.length > 0)
        yamlError({ indent, lineNumber, text }, 'multiple documents are not supported');
      continue;
    }
    if (text === '...') {
      documentEnded = true;
      continue;
    }
    if (text.startsWith('%'))
      yamlError({ indent, lineNumber, text }, 'directives are not supported');
    lines.push({ indent, lineNumber, text });
  }
  return lines;
}

function findTopLevelColon(text: string): number {
  let quote: 'double' | 'single' | null = null;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" && quote !== 'double') {
      if (quote === 'single' && text[index + 1] === "'") index += 1;
      else quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (character === '"' && quote !== 'single' && text[index - 1] !== '\\') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (quote !== null) continue;
    if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth -= 1;
    else if (character === '{') curlyDepth += 1;
    else if (character === '}') curlyDepth -= 1;
    else if (
      character === ':' &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      (text[index + 1] === undefined || /\s/u.test(text[index + 1] ?? ''))
    ) {
      return index;
    }
  }
  return -1;
}

function splitFlowItems(text: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote: 'double' | 'single' | null = null;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" && quote !== 'double') {
      if (quote === 'single' && text[index + 1] === "'") index += 1;
      else quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (character === '"' && quote !== 'single' && text[index - 1] !== '\\') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (quote !== null) continue;
    if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth -= 1;
    else if (character === '{') curlyDepth += 1;
    else if (character === '}') curlyDepth -= 1;
    else if (character === ',' && squareDepth === 0 && curlyDepth === 0) {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last.length > 0) items.push(last);
  return items;
}

function parseYamlScalar(rawValue: string, line: YamlLine): unknown {
  const value = rawValue.trim();
  if (value.length === 0 || value === '~' || value.toLowerCase() === 'null') return null;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) yamlError(line, 'unterminated single-quoted scalar');
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) yamlError(line, 'unterminated double-quoted scalar');
    try {
      return JSON.parse(value) as string;
    } catch {
      yamlError(line, 'invalid double-quoted scalar');
    }
  }
  if (value.startsWith('[') || value.startsWith('{')) {
    const closing = value.startsWith('[') ? ']' : '}';
    if (!value.endsWith(closing)) yamlError(line, 'unterminated flow collection');
    if (value.startsWith('[')) {
      return splitFlowItems(value.slice(1, -1)).map((item) => parseYamlScalar(item, line));
    }
    const result: Record<string, unknown> = {};
    for (const item of splitFlowItems(value.slice(1, -1))) {
      const colon = findTopLevelColon(item);
      if (colon < 1) yamlError(line, 'flow map entries need a key and value');
      const key = parseYamlScalar(item.slice(0, colon), line);
      if (typeof key !== 'string') yamlError(line, 'flow map keys must be strings');
      if (Object.hasOwn(result, key)) yamlError(line, `duplicate key "${key}"`);
      result[key] = parseYamlScalar(item.slice(colon + 1), line);
    }
    return result;
  }
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number) || Number.isFinite(number)) return number;
  }
  if (value.startsWith('&') || value.startsWith('*') || value.includes(' !!')) {
    yamlError(line, 'anchors, aliases, and explicit tags are not supported in the built-in parser');
  }
  return value;
}

function parseBlockScalar(
  lines: readonly YamlLine[],
  startIndex: number,
  parentIndent: number,
  folded: boolean,
): { readonly index: number; readonly value: string } {
  const firstChild = lines[startIndex];
  if (firstChild === undefined || firstChild.indent <= parentIndent)
    return { index: startIndex, value: '' };
  const childIndent = firstChild.indent;
  const parts: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < childIndent) break;
    if (line.indent !== childIndent)
      throw new YamlSyntaxError(line.lineNumber, 'inconsistent indentation');
    parts.push(line.text);
    index += 1;
  }
  return { index, value: folded ? parts.join(' ') : `${parts.join('\n')}\n` };
}

function parseYamlNode(
  lines: readonly YamlLine[],
  startIndex: number,
  indent: number,
): { readonly index: number; readonly value: unknown } {
  const firstLine = lines[startIndex];
  if (firstLine === undefined) return { index: startIndex, value: null };
  if (firstLine.indent !== indent) yamlError(firstLine, `expected indentation ${indent} spaces`);
  if (
    firstLine.text !== '-' &&
    !firstLine.text.startsWith('- ') &&
    findTopLevelColon(firstLine.text) < 1
  ) {
    return { index: startIndex + 1, value: parseYamlScalar(firstLine.text, firstLine) };
  }
  return firstLine.text === '-' || firstLine.text.startsWith('- ')
    ? parseYamlList(lines, startIndex, indent)
    : parseYamlMap(lines, startIndex, indent);
}

function parseYamlList(
  lines: readonly YamlLine[],
  startIndex: number,
  indent: number,
): { readonly index: number; readonly value: unknown[] } {
  const result: unknown[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (
      line === undefined ||
      line.indent !== indent ||
      !(line.text === '-' || line.text.startsWith('- '))
    )
      break;
    const rest = line.text.slice(1).trim();
    index += 1;
    if (rest.length === 0) {
      const child = lines[index];
      if (child !== undefined && child.indent > indent) {
        const parsed = parseYamlNode(lines, index, child.indent);
        result.push(parsed.value);
        index = parsed.index;
      } else {
        result.push(null);
      }
      continue;
    }

    const colon = findTopLevelColon(rest);
    if (colon > 0) {
      const object: Record<string, unknown> = {};
      const keyValue = parseMapEntry(
        lines,
        index,
        indent,
        rest.slice(0, colon),
        rest.slice(colon + 1),
      );
      if (Object.hasOwn(object, keyValue.key)) yamlError(line, `duplicate key "${keyValue.key}"`);
      object[keyValue.key] = keyValue.value;
      index = keyValue.index;
      const continuation = lines[index];
      if (continuation !== undefined && continuation.indent > indent) {
        const parsed = parseYamlMap(lines, index, continuation.indent);
        if (
          typeof parsed.value !== 'object' ||
          parsed.value === null ||
          Array.isArray(parsed.value)
        ) {
          yamlError(continuation, 'list item mapping must continue with key/value pairs');
        }
        for (const [continuationKey, continuationValue] of Object.entries(parsed.value)) {
          if (Object.hasOwn(object, continuationKey))
            yamlError(continuation, `duplicate key "${continuationKey}"`);
          object[continuationKey] = continuationValue;
        }
        index = parsed.index;
      }
      result.push(object);
      continue;
    }

    result.push(parseYamlScalar(rest, line));
    const childAfterScalar = lines[index];
    if (childAfterScalar !== undefined && childAfterScalar.indent > indent) {
      yamlError(childAfterScalar, 'unexpected indentation after a scalar list item');
    }
  }
  return { index, value: result };
}

function parseMapEntry(
  lines: readonly YamlLine[],
  startIndex: number,
  parentIndent: number,
  rawKey: string,
  rawValue: string,
): { readonly index: number; readonly key: string; readonly value: unknown } {
  const line = lines[startIndex - 1] ??
    lines[startIndex] ?? { indent: parentIndent, lineNumber: 1, text: rawKey };
  const parsedKey = parseYamlScalar(rawKey.trim(), line);
  if (typeof parsedKey !== 'string' || parsedKey.length === 0)
    yamlError(line, 'map keys must be non-empty strings');
  const value = rawValue.trim();
  if (value === '|' || value === '>') {
    const block = parseBlockScalar(lines, startIndex, parentIndent, value === '>');
    return { index: block.index, key: parsedKey, value: block.value };
  }
  if (value.length > 0)
    return { index: startIndex, key: parsedKey, value: parseYamlScalar(value, line) };
  const child = lines[startIndex];
  if (child !== undefined && child.indent > parentIndent) {
    const parsed = parseYamlNode(lines, startIndex, child.indent);
    return { index: parsed.index, key: parsedKey, value: parsed.value };
  }
  return { index: startIndex, key: parsedKey, value: null };
}

function parseYamlMap(
  lines: readonly YamlLine[],
  startIndex: number,
  indent: number,
): { readonly index: number; readonly value: Record<string, unknown> } {
  const result: Record<string, unknown> = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (
      line === undefined ||
      line.indent !== indent ||
      line.text === '-' ||
      line.text.startsWith('- ')
    )
      break;
    const colon = findTopLevelColon(line.text);
    if (colon < 1) yamlError(line, 'map entries need a key followed by a colon');
    const entry = parseMapEntry(
      lines,
      index + 1,
      indent,
      line.text.slice(0, colon),
      line.text.slice(colon + 1),
    );
    if (Object.hasOwn(result, entry.key)) yamlError(line, `duplicate key "${entry.key}"`);
    result[entry.key] = entry.value;
    index = entry.index;
  }
  return { index, value: result };
}

export function parseYamlSubset(source: string): unknown {
  const lines = readYamlLines(source.startsWith('\uFEFF') ? source.slice(1) : source);
  if (lines.length === 0) return null;
  const first = lines[0];
  if (first === undefined) return null;
  const parsed = parseYamlNode(lines, 0, first.indent);
  const remaining = lines[parsed.index];
  if (remaining !== undefined)
    yamlError(remaining, `unexpected indentation or content after the root value`);
  return parsed.value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

function scalarClass(value: unknown): string {
  if (value === null) return 'structured-tree-null';
  if (typeof value === 'string') return 'structured-tree-string';
  if (typeof value === 'number') return 'structured-tree-number';
  if (typeof value === 'boolean') return 'structured-tree-boolean';
  return '';
}

interface TreeRenderState {
  rendered: number;
  truncated: boolean;
}

function valueMatches(
  value: unknown,
  key: string | undefined,
  path: string,
  query: string,
): boolean {
  if (query.length === 0) return true;
  const haystack =
    `${key ?? ''} ${path} ${typeof value === 'string' ? value : displayScalar(value)}`.toLocaleLowerCase();
  return haystack.includes(query);
}

function childEntries(value: unknown): readonly [string, unknown][] {
  if (Array.isArray(value)) return value.map((child, index) => [`${index}`, child]);
  if (isObject(value)) return Object.entries(value);
  return [];
}

function containsQuery(value: unknown, query: string): boolean {
  if (query.length === 0) return true;
  if (valueMatches(value, undefined, '', query)) return true;
  return childEntries(value).some(
    ([key, child]) => key.toLocaleLowerCase().includes(query) || containsQuery(child, query),
  );
}

function renderTreeNode(
  value: unknown,
  key: string | undefined,
  path: string,
  depth: number,
  query: string,
  maxNodes: number,
  state: TreeRenderState,
): ReactNode {
  if (state.rendered >= maxNodes) {
    state.truncated = true;
    return null;
  }
  state.rendered += 1;
  const selfMatches = valueMatches(value, key, path, query);
  const children = childEntries(value);
  if (children.length === 0) {
    if (!selfMatches) return null;
    return (
      <div className="structured-tree-leaf" data-path={path} key={path}>
        {key === undefined ? null : <span className="structured-tree-key">{key}</span>}
        <span className={`structured-tree-value ${scalarClass(value)}`}>
          {displayScalar(value)}
        </span>
      </div>
    );
  }

  const visibleChildren =
    query.length > 0 && !selfMatches
      ? children.filter(
          ([childKey, childValue]) =>
            childKey.toLocaleLowerCase().includes(query) || containsQuery(childValue, query),
        )
      : children;
  if (query.length > 0 && !selfMatches && visibleChildren.length === 0) return null;
  const typeLabel = Array.isArray(value) ? `${children.length} items` : `${children.length} keys`;
  return (
    <details
      className="structured-tree-node"
      data-path={path}
      key={path}
      open={depth === 0 || query.length > 0}
    >
      <summary>
        {key === undefined ? (
          <span className="structured-tree-key">root</span>
        ) : (
          <span className="structured-tree-key">{key}</span>
        )}
        <span className="structured-tree-type">{typeLabel}</span>
      </summary>
      <div className="structured-tree-children">
        {visibleChildren.map(([childKey, childValue]) =>
          renderTreeNode(
            childValue,
            Array.isArray(value) ? `[${childKey}]` : childKey,
            `${path}.${childKey}`,
            depth + 1,
            query,
            maxNodes,
            state,
          ),
        )}
      </div>
    </details>
  );
}

function renderStructuredTree(
  value: unknown,
  query: string,
  maxNodes: number,
): { readonly content: ReactNode; readonly state: TreeRenderState } {
  const state: TreeRenderState = { rendered: 0, truncated: false };
  const content = renderTreeNode(value, undefined, '$', 0, query, maxNodes, state);
  return { content, state };
}

export function StructuredDataPreview({
  fileName = 'data.json',
  initialMode,
  maxNodes = DEFAULT_MAX_NODES,
  maxSourceLength = DEFAULT_MAX_SOURCE_LENGTH,
  mediaType,
  showFileIdentity = true,
  showModeTabs = true,
  source,
  yamlParser,
}: StructuredDataPreviewProps) {
  const [mode, setMode] = useState<PreviewMode>(initialMode ?? 'preview');
  const [query, setQuery] = useState('');
  const searchId = useId();
  const parsed = useMemo(
    () => parseStructuredSource(source, { fileName, maxSourceLength, mediaType, yamlParser }),
    [fileName, maxSourceLength, mediaType, source, yamlParser],
  );
  const activeMode = showModeTabs ? mode : 'preview';
  const tree = parsed.ok
    ? renderStructuredTree(parsed.value, query.trim().toLocaleLowerCase(), Math.max(1, maxNodes))
    : null;
  const treeHasResults = tree?.content !== null && tree?.content !== undefined;

  return (
    <section
      aria-label={`${fileName} structured data preview`}
      className="preview-component structured-data-preview"
    >
      {showFileIdentity || showModeTabs ? (
        <div className="preview-toolbar">
          {showFileIdentity ? (
            <div className="preview-toolbar-start">
              <span className="preview-toolbar-label" title={fileName}>
                {fileName}
              </span>
              <span className="preview-toolbar-meta">
                {parsed.ok ? parsed.format.toUpperCase() : 'Source'}
              </span>
            </div>
          ) : null}
          {showModeTabs ? <PreviewModeTabs activeMode={mode} onModeChange={setMode} /> : null}
        </div>
      ) : null}
      {activeMode === 'source' ? (
        <PreviewPanel label={`${fileName} source`}>
          <SourcePane source={source} />
        </PreviewPanel>
      ) : parsed.ok ? (
        <PreviewPanel label={`${fileName} data tree`}>
          <div className="preview-toolbar preview-toolbar-subtle">
            <div className="structured-data-filter">
              <MagnifyingGlassIcon aria-hidden="true" size={15} />
              <label className="structured-data-visually-hidden" htmlFor={searchId}>
                Filter structured data
              </label>
              <input
                aria-label="Filter structured data"
                className="structured-data-search"
                id={searchId}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search keys and values"
                type="search"
                value={query}
              />
            </div>
            <span className="preview-toolbar-meta">
              <BracketsCurlyIcon aria-hidden="true" size={14} />
              {tree?.state.rendered.toLocaleString()} nodes
              {tree?.state.truncated ? ' · preview limit reached' : ''}
            </span>
          </div>
          <section aria-label="Structured data tree" aria-live="polite" className="structured-tree">
            <div className="structured-tree-root">
              {treeHasResults ? (
                tree?.content
              ) : (
                <p className="structured-tree-no-results">No matching keys or values.</p>
              )}
              {tree?.state.truncated ? (
                <p className="structured-tree-truncated">
                  Preview stopped after {Math.max(1, maxNodes).toLocaleString()} nodes. Source mode
                  contains the complete file.
                </p>
              ) : null}
            </div>
          </section>
        </PreviewPanel>
      ) : (
        <PreviewPanel label={`${fileName} parse error`}>
          <ParseErrorNotice error={parsed.error} source={source} />
        </PreviewPanel>
      )}
    </section>
  );
}
