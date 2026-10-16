import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import { type DefaultTreeAdapterMap, parse } from 'parse5';

export type FolderSiteWarningCode =
  | 'ROOT_RELATIVE_REFERENCE'
  | 'EXTERNAL_REFERENCE'
  | 'BARE_MODULE_SPECIFIER'
  | 'UNBUILT_SOURCE'
  | 'MISSING_REFERENCE'
  | 'DIRECTORY_REFERENCE'
  | 'NO_ROOT_INDEX';

export interface FolderSiteWarning {
  readonly code: FolderSiteWarningCode;
  readonly path: string;
  readonly reference: string;
  readonly message: string;
}

export interface FolderSiteCheckFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly byteCount: number;
}

export interface FolderSiteCheckInput {
  readonly files: readonly FolderSiteCheckFile[];
  readonly manifest?: {
    readonly entries: readonly { readonly path: string; readonly kind: string }[];
  };
}

export const MAX_FOLDER_SITE_WARNINGS = 32;
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

type ReferenceKind = 'subresource' | 'navigation' | 'module';

interface Reference {
  readonly value: string;
  readonly kind: ReferenceKind;
  readonly unbuiltCheck: boolean;
}

const IGNORED_SCHEME = /^(?:data|blob|mailto|tel|javascript|about):/iu;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const EXTERNAL = /^(?:https?:)?\/\//iu;
const UNBUILT_EXTENSION = /\.(?:tsx?|jsx|vue|svelte)$/iu;
const SCANNED_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs']);
const URL_ATTRIBUTE_ELEMENTS = new Set([
  'link',
  'a',
  'area',
  'script',
  'img',
  'source',
  'video',
  'audio',
  'track',
  'iframe',
  'embed',
]);
const NAVIGATION_ELEMENTS = new Set(['a', 'area']);
const HINT_ONLY_LINK_RELATIONS = new Set(['canonical', 'preconnect', 'dns-prefetch']);

const MESSAGES: Record<Exclude<FolderSiteWarningCode, 'NO_ROOT_INDEX'>, string> = {
  ROOT_RELATIVE_REFERENCE:
    'Use a relative path; root-relative paths resolve outside the published folder.',
  EXTERNAL_REFERENCE:
    'Bundle this file into the folder and reference it by relative path; external subresources are blocked.',
  BARE_MODULE_SPECIFIER:
    'Bundle the dependency into the folder and import it by relative path; bare module specifiers cannot be resolved.',
  UNBUILT_SOURCE:
    'Build this source to JavaScript and reference the built file; browsers cannot run it directly.',
  MISSING_REFERENCE: 'Add the referenced file to the folder or fix the path; it is not published.',
  DIRECTORY_REFERENCE:
    'End the path with a slash such as docs/ so it opens that directory index.html.',
};

/** Suggest the relative form of a root-relative reference, as seen from the referencing file. */
function rootRelativeMessage(from: string, reference: string): string {
  const directory = posix.dirname(from);
  const relative = posix.relative(directory === '.' ? '' : directory, reference.slice(1)) || './';
  return `Use the relative path ${relative}; root-relative paths resolve outside the published folder. For a Vite build, set base: './'.`;
}

const NO_ROOT_INDEX_MESSAGE =
  'Add an index.html at the folder root; the folder has HTML files but no root index.html.';

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

class Collector {
  private readonly seen = new Map<string, FolderSiteWarning>();

  private readonly filePaths: ReadonlySet<string>;
  private readonly directoryPaths: ReadonlySet<string>;
  private readonly importMapKeys: ReadonlySet<string>;

  constructor(
    filePaths: ReadonlySet<string>,
    directoryPaths: ReadonlySet<string>,
    importMapKeys: ReadonlySet<string>,
  ) {
    this.filePaths = filePaths;
    this.directoryPaths = directoryPaths;
    this.importMapKeys = importMapKeys;
  }

  private mapped(specifier: string): boolean {
    if (this.importMapKeys.has(specifier)) return true;
    for (const key of this.importMapKeys) {
      if (key.endsWith('/') && specifier.startsWith(key)) return true;
    }
    return false;
  }

  add(code: FolderSiteWarningCode, path: string, reference: string, message?: string): void {
    const key = `${code}\u0000${path}\u0000${reference}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, {
      code,
      path,
      reference,
      message: message ?? (code === 'NO_ROOT_INDEX' ? NO_ROOT_INDEX_MESSAGE : MESSAGES[code]),
    });
  }

  check(from: string, reference: Reference): void {
    const value = reference.value.trim();
    if (value.length === 0 || value.startsWith('#') || IGNORED_SCHEME.test(value)) return;
    if (EXTERNAL.test(value)) {
      if (reference.kind !== 'navigation') this.add('EXTERNAL_REFERENCE', from, value);
      return;
    }
    if (ANY_SCHEME.test(value)) return;
    if (value.startsWith('/')) {
      this.add('ROOT_RELATIVE_REFERENCE', from, value, rootRelativeMessage(from, value));
      return;
    }
    if (reference.kind === 'module' && !value.startsWith('./') && !value.startsWith('../')) {
      // A page's import map can resolve a bare specifier to a file in the folder.
      if (!this.mapped(value)) this.add('BARE_MODULE_SPECIFIER', from, value);
      return;
    }
    const target = value.split('#')[0]?.split('?')[0] ?? '';
    if (target.length === 0) return;
    const decoded = decode(target);
    const directory = posix.dirname(from);
    const joined = posix.normalize(posix.join(directory === '.' ? '' : directory, decoded));
    if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) {
      this.add('MISSING_REFERENCE', from, value);
      return;
    }
    if (reference.unbuiltCheck && UNBUILT_EXTENSION.test(joined)) {
      this.add('UNBUILT_SOURCE', from, value);
      return;
    }
    const directoryPath = joined.replace(/\/$/u, '').replace(/^\.$/u, '');
    const normalized = decoded.endsWith('/')
      ? posix.join(directoryPath, 'index.html')
      : directoryPath;
    // Shelf serves a directory's index.html only for a path that ends in a slash.
    if (this.filePaths.has(normalized)) return;
    this.add(
      this.directoryPaths.has(normalized) ? 'DIRECTORY_REFERENCE' : 'MISSING_REFERENCE',
      from,
      value,
    );
  }

  warnings(hasHtml: boolean): FolderSiteWarning[] {
    if (hasHtml && !this.filePaths.has('index.html')) this.add('NO_ROOT_INDEX', '', '');
    return [...this.seen.values()]
      .sort(
        (left, right) =>
          compare(left.path, right.path) ||
          compare(left.reference, right.reference) ||
          compare(left.code, right.code),
      )
      .slice(0, MAX_FOLDER_SITE_WARNINGS);
  }
}

function cssReferences(source: string): Reference[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const found: Reference[] = [];
  const patterns = [/@import\s+(['"])([^'"\n]+)\1/gu, /\burl\(\s*(['"]?)([^'")]+?)\1\s*\)/giu];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[2] !== undefined) {
        found.push({ value: match[2], kind: 'subresource', unbuiltCheck: false });
      }
    }
  }
  return found;
}

function scriptReferences(source: string): Reference[] {
  const found: Reference[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[\w*${}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/gu,
    /\bimport\(\s*(['"`])([^'"`\n$]+)\1\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[2] !== undefined) {
        found.push({ value: match[2], kind: 'module', unbuiltCheck: true });
      }
    }
  }
  return found;
}

function srcsetUrls(value: string): string[] {
  if (/^\s*data:/iu.test(value)) return [];
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/u)[0] ?? '')
    .filter((url) => url.length > 0);
}

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

function textContent(element: Element): string {
  return element.childNodes
    .map((child) => ('value' in child && child.nodeName === '#text' ? child.value : ''))
    .join('');
}

function isHintOnlyLink(element: Element): boolean {
  if (element.tagName !== 'link') return false;
  return (attribute(element, 'rel') ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .some((relation) => HINT_ONLY_LINK_RELATIONS.has(relation));
}

function elementReferences(element: Element): Reference[] {
  const tag = element.tagName;
  const found: Reference[] = [];
  const style = attribute(element, 'style');
  if (style !== undefined) found.push(...cssReferences(style));
  if (tag === 'style') found.push(...cssReferences(textContent(element)));
  if (
    tag === 'script' &&
    attribute(element, 'src') === undefined &&
    attribute(element, 'type')?.trim().toLowerCase() === 'module'
  ) {
    found.push(...scriptReferences(textContent(element)));
  }
  if (URL_ATTRIBUTE_ELEMENTS.has(tag) && !isHintOnlyLink(element)) {
    const kind = NAVIGATION_ELEMENTS.has(tag) ? 'navigation' : 'subresource';
    for (const name of ['src', 'href']) {
      const value = attribute(element, name);
      if (value !== undefined) found.push({ value, kind, unbuiltCheck: tag === 'script' });
    }
  }
  const poster = attribute(element, 'poster');
  if (poster !== undefined) found.push({ value: poster, kind: 'subresource', unbuiltCheck: false });
  const srcset = attribute(element, 'srcset');
  if (srcset !== undefined) {
    for (const url of srcsetUrls(srcset)) {
      found.push({ value: url, kind: 'subresource', unbuiltCheck: false });
    }
  }
  return found;
}

/** Specifier keys and target URLs of an inline `<script type="importmap">`. */
function importMap(element: Element): { keys: string[]; targets: Reference[] } {
  try {
    const parsed = JSON.parse(textContent(element)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { keys: [], targets: [] };
    const { imports, scopes } = parsed as { imports?: unknown; scopes?: unknown };
    const maps = [
      imports,
      ...(typeof scopes === 'object' && scopes !== null ? Object.values(scopes) : []),
    ];
    const keys: string[] = [];
    const targets: Reference[] = [];
    for (const map of maps) {
      if (typeof map !== 'object' || map === null) continue;
      for (const [key, target] of Object.entries(map)) {
        keys.push(key);
        // A prefix target such as ./vendor/addons/ names a directory, so only its origin is checked.
        const prefix = typeof target === 'string' && target.endsWith('/');
        if (
          typeof target === 'string' &&
          (!prefix || EXTERNAL.test(target) || target.startsWith('/'))
        ) {
          targets.push({ value: target, kind: 'subresource', unbuiltCheck: true });
        }
      }
    }
    return { keys, targets };
  } catch {
    return { keys: [], targets: [] };
  }
}

function htmlReferences(source: string, importMapKeys: Set<string>): Reference[] {
  const found: Reference[] = [];
  const visit = (node: Node): void => {
    if (isElement(node)) {
      if (
        node.tagName === 'script' &&
        attribute(node, 'type')?.trim().toLowerCase() === 'importmap'
      ) {
        const map = importMap(node);
        for (const key of map.keys) importMapKeys.add(key);
        found.push(...map.targets);
      }
      found.push(...elementReferences(node));
      if (node.tagName === 'template' && 'content' in node) visit(node.content as Node);
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(source));
  return found;
}

function referencesFor(path: string, source: string, importMapKeys: Set<string>): Reference[] {
  switch (extension(path)) {
    case '.html':
    case '.htm':
      return htmlReferences(source, importMapKeys);
    case '.css':
      return cssReferences(source);
    default:
      return scriptReferences(source);
  }
}

/**
 * Advisory scan of a prepared local folder for references that will not work when the folder is
 * served as a static site. Unreadable files are skipped; the check never throws for them.
 */
export async function checkFolderSite(folder: FolderSiteCheckInput): Promise<FolderSiteWarning[]> {
  const filePaths = new Set(folder.files.map((file) => file.path));
  const directoryPaths = new Set(
    (folder.manifest?.entries ?? [])
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => entry.path),
  );
  const importMapKeys = new Set<string>();
  const found: { readonly from: string; readonly reference: Reference }[] = [];
  let hasHtml = false;
  for (const file of folder.files) {
    const kind = extension(file.path);
    if (kind === '.html' || kind === '.htm') hasHtml = true;
    if (!SCANNED_EXTENSIONS.has(kind) || file.byteCount > MAX_SCANNED_BYTES) continue;
    let source: string;
    try {
      source = await readFile(file.absolutePath, 'utf8');
    } catch {
      continue;
    }
    for (const reference of referencesFor(file.path, source, importMapKeys)) {
      found.push({ from: file.path, reference });
    }
  }
  // Import maps from every page are known before any module specifier is judged.
  const collector = new Collector(filePaths, directoryPaths, importMapKeys);
  for (const { from, reference } of found) collector.check(from, reference);
  return collector.warnings(hasHtml);
}
