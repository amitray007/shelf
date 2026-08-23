import type {
  DocxBlock,
  DocxDocument,
  DocxInlineRun,
  DocxPage,
  DocxPreviewAdapter,
  DocxPreviewLoadOptions,
  DocxTableBlock,
  DocxTableCell,
  DocxTextBlock,
  OfficeDocumentMetadata,
  OfficeDocumentSource,
} from './office-document-preview.js';
import {
  boundWorkbookModel,
  DEFAULT_WORKBOOK_PREVIEW_LIMITS,
  type WorkbookCell,
  type WorkbookFormat,
  type WorkbookPreviewAdapter,
  type WorkbookPreviewLimits,
  type WorkbookPreviewLoadOptions,
  type WorkbookPreviewMetadata,
  type WorkbookPreviewModel,
  type WorkbookSheet,
} from './workbook-preview.js';

/** The stable part of docx-preview's current browser API used by this adapter. */
export interface DocxPreviewModule {
  readonly renderAsync: (
    source: ArrayBuffer | Blob | Uint8Array,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement | null,
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
}

export interface DocxAdapterLimits {
  readonly maxSourceBytes: number;
  readonly maxPages: number;
  readonly maxBlocksPerPage: number;
  readonly maxRunsPerBlock: number;
  readonly maxCharactersPerRun: number;
  readonly maxTableRows: number;
  readonly maxTableColumns: number;
  readonly maxTableCells: number;
}

export const DEFAULT_DOCX_ADAPTER_LIMITS: DocxAdapterLimits = {
  maxBlocksPerPage: 1_000,
  maxCharactersPerRun: 20_000,
  maxPages: 100,
  maxRunsPerBlock: 100,
  maxSourceBytes: 25 * 1024 * 1024,
  maxTableCells: 10_000,
  maxTableColumns: 100,
  maxTableRows: 2_000,
};

export interface DocxAdapterOptions {
  readonly limits?: Partial<DocxAdapterLimits> | undefined;
  /** Tests and isolated hosts can supply an inert document implementation. */
  readonly documentFactory?: (() => Document) | undefined;
  readonly renderOptions?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * `docx-preview` uses a global `document` in its `h` hook. This shape is the small object subset
 * needed by that hook, allowing the factory to redirect every generated node into a detached
 * document instead of the live Shelf DOM.
 */
export interface DocxPreviewElementSpec {
  readonly tagName: string;
  readonly ns?: string | undefined;
  readonly className?: string | undefined;
  readonly style?: string | Readonly<Record<string, string>> | undefined;
  readonly children?: readonly unknown[] | undefined;
  readonly [property: string]: unknown;
}

export type DocxPreviewHook = (value: unknown) => unknown;

export const DOCX_ADAPTER_INTEGRATION = {
  packageName: 'docx-preview',
  version: '0.4.0',
  source: 'https://github.com/VolodymyrBaydalka/docxjs',
  api: 'renderAsync(source, detachedBody, detachedStyles, options)',
  note: 'The adapter uses the v0.4 h hook, then maps inert text/table semantics into DocxDocument.',
} as const;

export interface WorkbookParserReadOptions {
  readonly format: WorkbookFormat;
  readonly signal?: AbortSignal | undefined;
  readonly formulas: 'inert';
  readonly macros: 'ignore';
  readonly externalLinks: 'ignore';
  /** Optional conversion bounds for parsers that can apply them while mapping rows. */
  readonly maxRows?: number | undefined;
  readonly maxColumns?: number | undefined;
  readonly maxCells?: number | undefined;
}

export interface WorkbookParserCell {
  readonly row: number;
  readonly column: number;
  /** Prefer a parser's cached/display-formatted value. The adapter never calculates it. */
  readonly displayText?: unknown;
  readonly value?: unknown;
  readonly formula?: unknown;
  readonly rowSpan?: number | undefined;
  readonly colSpan?: number | undefined;
}

export interface WorkbookParserMerge {
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly colSpan: number;
}

export interface WorkbookParserSheet {
  readonly name: string;
  readonly rowCount?: number | undefined;
  readonly columnCount?: number | undefined;
  readonly cells: readonly WorkbookParserCell[];
  readonly mergedRanges?: readonly WorkbookParserMerge[] | undefined;
  readonly truncated?: boolean | undefined;
}

export interface WorkbookParserWorkbook {
  readonly sheets: readonly WorkbookParserSheet[];
}

/**
 * A parser-port boundary for modern XLSX readers. This keeps the display model independent from
 * parser objects and lets the app bind a browser reader without exposing parser capabilities to
 * the preview components.
 */
export interface WorkbookParserModule {
  readonly read: (
    source: ArrayBuffer,
    options: WorkbookParserReadOptions,
  ) => WorkbookParserWorkbook | Promise<WorkbookParserWorkbook>;
}

export interface WorkbookAdapterOptions {
  readonly limits?: Partial<WorkbookPreviewLimits> | undefined;
}

export const WORKBOOK_ADAPTER_INTEGRATION = {
  packageName: 'read-excel-file',
  version: '9.3.10',
  source: 'https://gitlab.com/catamphetamine/read-excel-file',
  browserApi: 'Use the browser entry default readXlsxFile(ArrayBuffer, options).',
  supportedFormats: ['xlsx'] as const,
  note: 'The browser reader returns display values and sheet names. XLS and ODS remain download-only inputs.',
} as const;

const SAFE_TAGS = new Set([
  'a',
  'br',
  'blockquote',
  'code',
  'dd',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'span',
  'style',
  'strong',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

const IGNORED_TAGS = new Set([
  'audio',
  'button',
  'canvas',
  'embed',
  'form',
  'iframe',
  'img',
  'input',
  'link',
  'object',
  'option',
  'script',
  'select',
  'style',
  'svg',
  'textarea',
  'video',
]);

const TEXT_BLOCK_TAGS = new Set([
  'blockquote',
  'dd',
  'div',
  'li',
  'p',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

function asTagName(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isNodeLike(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    typeof value.nodeType === 'number' &&
    'appendChild' in value &&
    typeof value.appendChild === 'function'
  );
}

function isElement(value: unknown): value is Element {
  return isNodeLike(value) && value.nodeType === 1 && 'tagName' in value;
}

function elementTag(element: Element): string {
  return element.tagName.toLowerCase();
}

function elementChildren(element: Element): readonly Element[] {
  return Array.from(element.children);
}

function descendants(root: Element): Element[] {
  const result: Element[] = [];
  const visit = (element: Element) => {
    for (const child of elementChildren(element)) {
      result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

function hasClass(element: Element, className: string): boolean {
  return (
    element.classList.contains(className) ||
    (element.getAttribute('class') ?? '').split(/\s+/u).includes(className)
  );
}

function attr(element: Element, name: string): string {
  return element.getAttribute(name) ?? '';
}

function styleText(element: Element): string {
  return attr(element, 'style');
}

function styleNumber(element: Element, property: string, fallback: number): number {
  const expression = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)px`, 'iu');
  const inlineStyle = (element as HTMLElement).style?.getPropertyValue?.(property) ?? '';
  const match = `${styleText(element)};${inlineStyle}`.match(expression);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) >= 0 ? Math.floor(value ?? 0) : fallback;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const result = safeInteger(value, fallback);
  return result > 0 ? result : fallback;
}

function abortError(): Error {
  const error = new Error('Office preview loading was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

function sourceByteCount(source: OfficeDocumentSource): number | undefined {
  if (source instanceof ArrayBuffer) return source.byteLength;
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source.size;
  return undefined;
}

async function readSourceBytes(
  source: OfficeDocumentSource,
  maxSourceBytes: number,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const knownSize = sourceByteCount(source);
  if (knownSize !== undefined && knownSize > maxSourceBytes) {
    throw new Error(
      `Office source exceeds the ${Math.round(maxSourceBytes / 1_000_000)} MB preview limit.`,
    );
  }
  if (source instanceof ArrayBuffer) return source;
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const bytes = await source.arrayBuffer();
    if (bytes.byteLength > maxSourceBytes) {
      throw new Error(
        `Office source exceeds the ${Math.round(maxSourceBytes / 1_000_000)} MB preview limit.`,
      );
    }
    throwIfAborted(signal);
    return bytes;
  }

  const response =
    signal === undefined ? await fetch(String(source)) : await fetch(String(source), { signal });
  if (!response.ok) throw new Error(`Office source could not be fetched (${response.status}).`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxSourceBytes) {
    throw new Error(
      `Office source exceeds the ${Math.round(maxSourceBytes / 1_000_000)} MB preview limit.`,
    );
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxSourceBytes) {
    throw new Error(
      `Office source exceeds the ${Math.round(maxSourceBytes / 1_000_000)} MB preview limit.`,
    );
  }
  throwIfAborted(signal);
  return bytes;
}

function createDetachedDocument(factory: (() => Document) | undefined): Document {
  if (factory !== undefined) return factory();
  if (
    typeof document === 'undefined' ||
    document.implementation?.createHTMLDocument === undefined
  ) {
    throw new Error('DOCX preview requires a browser document factory.');
  }
  return document.implementation.createHTMLDocument('Shelf DOCX preview');
}

function dangerousProperty(property: string): boolean {
  return /^(?:on|href|src|srcset|action|formaction|xlink:href)$/iu.test(property);
}

function createDetachedHook(ownerDocument: Document): DocxPreviewHook {
  const hook = (value: unknown): Node => {
    if (typeof value === 'string' || typeof value === 'number') {
      return ownerDocument.createTextNode(String(value));
    }
    if (isNodeLike(value)) {
      if ('ownerDocument' in value && value.ownerDocument === ownerDocument) return value;
      if (typeof ownerDocument.importNode === 'function')
        return ownerDocument.importNode(value, true);
      return ownerDocument.createTextNode('');
    }
    if (typeof value !== 'object' || value === null) return ownerDocument.createTextNode('');
    const spec = value as DocxPreviewElementSpec;
    const tag = asTagName(spec.tagName);
    if (tag === '#fragment') return ownerDocument.createDocumentFragment();
    if (tag === '#comment') return ownerDocument.createComment(String(spec.children?.[0] ?? ''));
    const safeTag = SAFE_TAGS.has(tag) ? tag : 'span';
    const element =
      spec.ns === undefined
        ? ownerDocument.createElement(safeTag)
        : ownerDocument.createElementNS(spec.ns, safeTag);
    if (typeof spec.className === 'string') element.setAttribute('class', spec.className);
    if (typeof spec.style === 'string') element.setAttribute('style', spec.style);
    if (typeof spec.style === 'object' && spec.style !== null) {
      for (const [property, propertyValue] of Object.entries(spec.style)) {
        if (!dangerousProperty(property) && typeof propertyValue === 'string') {
          (element as HTMLElement).style.setProperty(property, propertyValue);
        }
      }
    }
    for (const [property, propertyValue] of Object.entries(spec)) {
      if (
        property === 'tagName' ||
        property === 'ns' ||
        property === 'className' ||
        property === 'style' ||
        property === 'children' ||
        dangerousProperty(property) ||
        propertyValue === undefined
      )
        continue;
      if (/^[a-z][a-z0-9-]*$/iu.test(property) && typeof propertyValue === 'string') {
        element.setAttribute(property, propertyValue);
      }
    }
    for (const child of spec.children ?? []) element.appendChild(hook(child));
    return element;
  };
  return hook;
}

function clearElement(element: Element): void {
  while (element.firstChild !== null) element.removeChild(element.firstChild);
}

function findPages(body: HTMLElement): readonly Element[] {
  const allElements = descendants(body);
  const sectionPages = allElements.filter(
    (element) => elementTag(element) === 'section' && hasClass(element, 'docx'),
  );
  if (sectionPages.length > 0) return sectionPages;
  const markedPages = allElements.filter(
    (element) => attr(element, 'data-page').length > 0 || hasClass(element, 'docx-page'),
  );
  if (markedPages.length > 0) return markedPages;
  const fallback = elementChildren(body).filter(
    (element) => !IGNORED_TAGS.has(elementTag(element)),
  );
  return fallback.length > 0 ? fallback : [body];
}

function textFromElement(element: Element): string {
  const chunks: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      chunks.push(node.nodeValue ?? '');
      return;
    }
    if (!isElement(node) || IGNORED_TAGS.has(elementTag(node))) return;
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(element);
  return chunks.join('');
}

interface RunMarks {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly code: boolean;
}

function marksFor(element: Element, parent: RunMarks): RunMarks {
  const tag = elementTag(element);
  const style = styleText(element).toLowerCase();
  return {
    bold:
      parent.bold ||
      tag === 'b' ||
      tag === 'strong' ||
      /font-weight\s*:\s*(?:bold|[6-9]00)/u.test(style),
    code: parent.code || tag === 'code' || tag === 'pre',
    italic: parent.italic || tag === 'i' || tag === 'em' || /font-style\s*:\s*italic/u.test(style),
    underline: parent.underline || tag === 'u' || /text-decoration[^;]*underline/u.test(style),
  };
}

function appendRun(
  runs: DocxInlineRun[],
  text: string,
  marks: RunMarks,
  maxCharacters: number,
): number {
  if (text.length === 0) return 0;
  const remaining = maxCharacters - runs.reduce((total, run) => total + run.text.length, 0);
  if (remaining <= 0) return 0;
  const clipped = text.slice(0, remaining);
  const previous = runs.at(-1);
  if (
    previous !== undefined &&
    previous.bold === marks.bold &&
    previous.italic === marks.italic &&
    previous.underline === marks.underline &&
    previous.code === marks.code
  ) {
    runs[runs.length - 1] = { ...previous, text: previous.text + clipped };
  } else {
    runs.push({
      bold: marks.bold || undefined,
      code: marks.code || undefined,
      italic: marks.italic || undefined,
      text: clipped,
      underline: marks.underline || undefined,
    });
  }
  return clipped.length;
}

function runsFromElement(
  element: Element,
  limits: DocxAdapterLimits,
  markTruncated: () => void,
): readonly DocxInlineRun[] {
  const runs: DocxInlineRun[] = [];
  const visit = (node: Node, parentMarks: RunMarks) => {
    if (runs.length >= limits.maxRunsPerBlock) {
      markTruncated();
      return;
    }
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      const written = appendRun(runs, text, parentMarks, limits.maxCharactersPerRun);
      if (written < text.length) markTruncated();
      return;
    }
    if (!isElement(node) || IGNORED_TAGS.has(elementTag(node))) return;
    const marks = marksFor(node, parentMarks);
    for (const child of Array.from(node.childNodes)) visit(child, marks);
  };
  for (const child of Array.from(element.childNodes)) {
    visit(child, { bold: false, code: false, italic: false, underline: false });
  }
  return runs;
}

function collectBlocks(root: Element): readonly Element[] {
  const result: Element[] = [];
  const visit = (element: Element) => {
    const tag = elementTag(element);
    if (IGNORED_TAGS.has(tag)) return;
    if (tag === 'table') {
      result.push(element);
      return;
    }
    const children = elementChildren(element);
    const isTextBlock = TEXT_BLOCK_TAGS.has(tag);
    if (isTextBlock && !children.some((child) => TEXT_BLOCK_TAGS.has(elementTag(child)))) {
      result.push(element);
      return;
    }
    const before = result.length;
    for (const child of children) visit(child);
    if (
      before === result.length &&
      textFromElement(element).trim().length > 0 &&
      tag !== 'section'
    ) {
      result.push(element);
    }
  };
  for (const child of elementChildren(root)) visit(child);
  if (result.length === 0 && textFromElement(root).trim().length > 0) result.push(root);
  return result;
}

function textBlockFromElement(
  element: Element,
  pageWidth: number,
  fallbackY: number,
  limits: DocxAdapterLimits,
  markTruncated: () => void,
): DocxTextBlock {
  const tag = elementTag(element);
  const kind =
    tag.startsWith('h') && tag.length === 2 ? 'heading' : tag === 'li' ? 'list-item' : 'paragraph';
  const level =
    kind === 'heading' ? Math.min(6, Math.max(1, safeInteger(Number(tag.slice(1)), 1))) : undefined;
  const block: DocxTextBlock = {
    align: /text-align\s*:\s*(left|center|right|justify)/iu
      .exec(styleText(element))?.[1]
      ?.toLowerCase() as DocxTextBlock['align'],
    height: styleNumber(element, 'height', kind === 'heading' ? 32 : 26),
    kind,
    level,
    runs: runsFromElement(element, limits, markTruncated),
    width: styleNumber(element, 'width', Math.max(pageWidth - 96, 80)),
    x: styleNumber(element, 'left', 48),
    y: styleNumber(element, 'top', fallbackY),
  };
  return block;
}

function directCells(row: Element): readonly Element[] {
  return elementChildren(row).filter(
    (element) => elementTag(element) === 'td' || elementTag(element) === 'th',
  );
}

function tableBlockFromElement(
  table: Element,
  pageWidth: number,
  fallbackY: number,
  limits: DocxAdapterLimits,
): { readonly block: DocxTableBlock; readonly truncated: boolean } {
  let truncated = false;
  const rows = descendants(table)
    .filter((element) => elementTag(element) === 'tr')
    .slice(0, limits.maxTableRows);
  if (rows.length < descendants(table).filter((element) => elementTag(element) === 'tr').length)
    truncated = true;
  const mappedRows: DocxTableBlock['rows'][number][] = [];
  let cellCount = 0;
  for (const row of rows) {
    const cells = directCells(row).slice(0, limits.maxTableColumns);
    if (cells.length < directCells(row).length) truncated = true;
    const mappedCells: DocxTableCell[] = [];
    for (const cell of cells) {
      if (cellCount >= limits.maxTableCells) {
        truncated = true;
        break;
      }
      mappedCells.push({
        colSpan: Math.max(1, safeInteger(Number(attr(cell, 'colspan')), 1)),
        rowSpan: Math.max(1, safeInteger(Number(attr(cell, 'rowspan')), 1)),
        runs: runsFromElement(cell, limits, () => {
          truncated = true;
        }),
      });
      cellCount += 1;
    }
    mappedRows.push(mappedCells);
    if (cellCount >= limits.maxTableCells) break;
  }
  return {
    block: {
      height: styleNumber(table, 'height', Math.max(32, mappedRows.length * 30)),
      kind: 'table',
      rows: mappedRows,
      width: styleNumber(table, 'width', Math.max(pageWidth - 96, 80)),
      x: styleNumber(table, 'left', 48),
      y: styleNumber(table, 'top', fallbackY),
    },
    truncated,
  };
}

function mapDocxDocument(body: HTMLElement, limits: DocxAdapterLimits): DocxDocument {
  const pageElements = findPages(body).slice(0, limits.maxPages);
  let truncated = pageElements.length < findPages(body).length;
  const pages: DocxPage[] = [];
  pageElements.forEach((pageElement, pageIndex) => {
    const width = styleNumber(pageElement, 'width', 816);
    const height = styleNumber(pageElement, 'height', styleNumber(pageElement, 'min-height', 1056));
    const blocks: DocxBlock[] = [];
    let fallbackY = 48;
    const candidates = collectBlocks(pageElement);
    if (candidates.length > limits.maxBlocksPerPage) truncated = true;
    candidates.slice(0, limits.maxBlocksPerPage).forEach((element) => {
      let block: DocxBlock;
      if (elementTag(element) === 'table') {
        const table = tableBlockFromElement(element, width, fallbackY, limits);
        block = table.block;
        truncated ||= table.truncated;
      } else {
        block = textBlockFromElement(element, width, fallbackY, limits, () => {
          truncated = true;
        });
      }
      blocks.push(block);
      fallbackY = Math.max(fallbackY, block.y + block.height + 8);
    });
    pages.push({
      blocks,
      height,
      id: attr(pageElement, 'id') || attr(pageElement, 'data-page') || `page-${pageIndex + 1}`,
      width,
    });
  });
  return { pages, truncated };
}

function resolvedDocxLimits(overrides: Partial<DocxAdapterLimits> | undefined): DocxAdapterLimits {
  const limits = { ...DEFAULT_DOCX_ADAPTER_LIMITS, ...overrides };
  return {
    maxBlocksPerPage: positiveLimit(
      limits.maxBlocksPerPage,
      DEFAULT_DOCX_ADAPTER_LIMITS.maxBlocksPerPage,
    ),
    maxCharactersPerRun: positiveLimit(
      limits.maxCharactersPerRun,
      DEFAULT_DOCX_ADAPTER_LIMITS.maxCharactersPerRun,
    ),
    maxPages: positiveLimit(limits.maxPages, DEFAULT_DOCX_ADAPTER_LIMITS.maxPages),
    maxRunsPerBlock: positiveLimit(
      limits.maxRunsPerBlock,
      DEFAULT_DOCX_ADAPTER_LIMITS.maxRunsPerBlock,
    ),
    maxSourceBytes: positiveLimit(
      limits.maxSourceBytes,
      DEFAULT_DOCX_ADAPTER_LIMITS.maxSourceBytes,
    ),
    maxTableCells: positiveLimit(limits.maxTableCells, DEFAULT_DOCX_ADAPTER_LIMITS.maxTableCells),
    maxTableColumns: positiveLimit(
      limits.maxTableColumns,
      DEFAULT_DOCX_ADAPTER_LIMITS.maxTableColumns,
    ),
    maxTableRows: positiveLimit(limits.maxTableRows, DEFAULT_DOCX_ADAPTER_LIMITS.maxTableRows),
  };
}

export function createDocxPreviewAdapter(
  module: DocxPreviewModule,
  options: DocxAdapterOptions = {},
): DocxPreviewAdapter {
  const limits = resolvedDocxLimits(options.limits);
  return {
    async load(
      source: OfficeDocumentSource,
      metadata: OfficeDocumentMetadata,
      loadOptions?: DocxPreviewLoadOptions,
    ): Promise<DocxDocument> {
      const signal = loadOptions?.signal;
      throwIfAborted(signal);
      if (metadata.byteCount !== undefined && metadata.byteCount > limits.maxSourceBytes) {
        throw new Error(
          `DOCX source exceeds the ${Math.round(limits.maxSourceBytes / 1_000_000)} MB preview limit.`,
        );
      }
      const bytes = await readSourceBytes(source, limits.maxSourceBytes, signal);
      const ownerDocument = createDetachedDocument(options.documentFactory);
      const bodyContainer = ownerDocument.createElement('div');
      const styleContainer = ownerDocument.createElement('div');
      const renderOptions: Record<string, unknown> = {
        ...(options.renderOptions ?? {}),
        breakPages: true,
        h: createDetachedHook(ownerDocument),
        inWrapper: true,
        renderAltChunks: false,
        renderChanges: false,
        renderComments: false,
      };
      try {
        await module.renderAsync(bytes, bodyContainer, styleContainer, renderOptions);
        throwIfAborted(signal);
        const model = mapDocxDocument(bodyContainer, limits);
        throwIfAborted(signal);
        return model;
      } finally {
        clearElement(bodyContainer);
        clearElement(styleContainer);
      }
    },
  };
}

function resolvedWorkbookLimits(
  overrides: Partial<WorkbookPreviewLimits> | undefined,
): WorkbookPreviewLimits {
  const limits = { ...DEFAULT_WORKBOOK_PREVIEW_LIMITS, ...overrides };
  return {
    maxCells: positiveLimit(limits.maxCells, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxCells),
    maxColumns: positiveLimit(limits.maxColumns, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxColumns),
    maxRenderedColumns: positiveLimit(
      limits.maxRenderedColumns,
      DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxRenderedColumns,
    ),
    maxRenderedRows: positiveLimit(
      limits.maxRenderedRows,
      DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxRenderedRows,
    ),
    maxRows: positiveLimit(limits.maxRows, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxRows),
    maxSheets: positiveLimit(limits.maxSheets, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxSheets),
    maxSourceBytes: positiveLimit(
      limits.maxSourceBytes,
      DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxSourceBytes,
    ),
  };
}

function parserCellText(cell: WorkbookParserCell): string {
  if (cell.displayText !== undefined) return String(cell.displayText);
  if (typeof cell.formula === 'string') return cell.formula;
  if (cell.value === undefined || cell.value === null) return '';
  return String(cell.value);
}

function mergeMap(sheet: WorkbookParserSheet): ReadonlyMap<string, WorkbookParserMerge> {
  const map = new Map<string, WorkbookParserMerge>();
  for (const merge of sheet.mergedRanges ?? []) map.set(`${merge.row}:${merge.column}`, merge);
  return map;
}

function convertParserSheet(
  sheet: WorkbookParserSheet,
  limits: WorkbookPreviewLimits,
): { readonly sheet: WorkbookSheet; readonly truncated: boolean } {
  const mergeRanges = mergeMap(sheet);
  const rawCells = sheet.cells;
  let truncated = sheet.truncated === true;
  const rowCount = Math.min(
    limits.maxRows,
    Math.max(
      0,
      safeInteger(
        sheet.rowCount,
        rawCells.reduce((max, cell) => Math.max(max, cell.row + 1), 0),
      ),
    ),
  );
  const columnCount = Math.min(
    limits.maxColumns,
    Math.max(
      0,
      safeInteger(
        sheet.columnCount,
        rawCells.reduce((max, cell) => Math.max(max, cell.column + 1), 0),
      ),
    ),
  );
  if (
    (sheet.rowCount !== undefined && rowCount !== sheet.rowCount) ||
    (sheet.columnCount !== undefined && columnCount !== sheet.columnCount)
  ) {
    truncated = true;
  }
  const cells: WorkbookCell[] = [];
  for (const cell of rawCells) {
    if (cells.length >= limits.maxCells) {
      truncated = true;
      break;
    }
    if (
      !Number.isFinite(cell.row) ||
      !Number.isFinite(cell.column) ||
      cell.row < 0 ||
      cell.column < 0 ||
      cell.row >= rowCount ||
      cell.column >= columnCount
    ) {
      truncated = true;
      continue;
    }
    const merge = mergeRanges.get(`${cell.row}:${cell.column}`);
    const rowSpan = Math.min(
      Math.max(1, safeInteger(merge?.rowSpan ?? cell.rowSpan, 1)),
      rowCount - cell.row,
    );
    const colSpan = Math.min(
      Math.max(1, safeInteger(merge?.colSpan ?? cell.colSpan, 1)),
      columnCount - cell.column,
    );
    cells.push({
      colSpan,
      column: Math.floor(cell.column),
      formula: typeof cell.formula === 'string' ? cell.formula : undefined,
      row: Math.floor(cell.row),
      rowSpan,
      value: parserCellText(cell),
    });
  }
  if (cells.length < rawCells.length) truncated = true;
  return { sheet: { cells, columnCount, name: sheet.name, rowCount }, truncated };
}

export function createWorkbookPreviewAdapter(
  parser: WorkbookParserModule,
  options: WorkbookAdapterOptions = {},
): WorkbookPreviewAdapter {
  const limits = resolvedWorkbookLimits(options.limits);
  return {
    async load(
      source: OfficeDocumentSource,
      metadata: WorkbookPreviewMetadata,
      loadOptions?: WorkbookPreviewLoadOptions,
    ): Promise<WorkbookPreviewModel> {
      const signal = loadOptions?.signal;
      throwIfAborted(signal);
      if (metadata.format !== 'xlsx') {
        throw new Error('XLS and ODS workbook previews are download-only.');
      }
      const bytes = await readSourceBytes(source, limits.maxSourceBytes, signal);
      const workbook = await parser.read(bytes, {
        externalLinks: 'ignore',
        formulas: 'inert',
        format: metadata.format,
        maxCells: limits.maxCells,
        maxColumns: limits.maxColumns,
        maxRows: limits.maxRows,
        macros: 'ignore',
        signal,
      });
      throwIfAborted(signal);
      let truncated = workbook.sheets.length > limits.maxSheets;
      const sheets: WorkbookSheet[] = [];
      for (const parserSheet of workbook.sheets.slice(0, limits.maxSheets)) {
        throwIfAborted(signal);
        const converted = convertParserSheet(parserSheet, limits);
        sheets.push(converted.sheet);
        truncated ||= converted.truncated;
      }
      return boundWorkbookModel({ sheets, truncated }, limits);
    },
  };
}
