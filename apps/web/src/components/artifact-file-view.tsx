// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import { Button } from '@cloudflare/kumo/components/button';
import { DownloadSimpleIcon } from '@phosphor-icons/react/DownloadSimple';
import { type ReactNode, useEffect, useMemo } from 'react';

import {
  type PassiveRenderer,
  prefersSourceView,
  requiresClientBytes,
  selectRenderer,
  supportsSourceView,
} from '../rendering.js';
import { DownloadOnlyState } from './download-only-state.js';
import {
  CodeView,
  decodeFileSource,
  FileLoadingState,
  type FileReviewProps,
  FileView,
} from './file-view.js';
import { formatFileType } from './format.js';
import { LazyMarkdownView as MarkdownView } from './lazy-views.js';
import { DelimitedTablePreview } from './preview/delimited-table-preview.js';
import { AudioPreview, VideoPreview } from './preview/media-preview.js';
import { DocxPreview } from './preview/office-document-preview.js';
import { pdfJsAdapter } from './preview/pdf-js.js';
import { PdfViewer } from './preview/pdf-viewer.js';
import { StructuredDataPreview } from './preview/structured-data-preview.js';
import { WorkbookPreview } from './preview/workbook-preview.js';
import type { HtmlPreviewTheme } from './renderer-frame.js';

type HtmlRenderer = Extract<PassiveRenderer, { kind: 'html' }>;

export interface ArtifactFileDescriptor {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
}

export type ArtifactFileContent =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'ready';
      readonly bytes?: ArrayBuffer | undefined;
      readonly previewUrl?: string | undefined;
    };

export interface ArtifactFileCapabilities {
  readonly download?: (() => void) | undefined;
  readonly isolatedHtml?:
    | {
        readonly origin: string;
        readonly render: (renderer: HtmlRenderer, theme: HtmlPreviewTheme) => ReactNode;
      }
    | undefined;
}

export interface ArtifactFileSidebar {
  readonly controlsId?: string | undefined;
  readonly label: string;
  readonly onToggle: () => void;
  readonly open: boolean;
}

export interface ArtifactFileViewProps {
  readonly capabilities?: ArtifactFileCapabilities | undefined;
  readonly content: ArtifactFileContent;
  readonly file: ArtifactFileDescriptor;
  readonly review?: FileReviewProps | undefined;
  readonly sidebar?: ArtifactFileSidebar | undefined;
}

function FileImage({
  alt,
  bytes,
  mediaType,
  previewUrl,
}: {
  readonly alt: string;
  readonly bytes?: ArrayBuffer | undefined;
  readonly mediaType: string;
  readonly previewUrl?: string | undefined;
}) {
  const source = useMemo(
    () =>
      previewUrl === undefined && bytes !== undefined
        ? URL.createObjectURL(new Blob([bytes], { type: mediaType }))
        : previewUrl,
    [bytes, mediaType, previewUrl],
  );
  useEffect(
    () => () => {
      if (previewUrl === undefined && source?.startsWith('blob:')) URL.revokeObjectURL(source);
    },
    [previewUrl, source],
  );
  return (
    <div className="artifact-surface artifact-image">
      {source === undefined ? null : <img alt={alt} referrerPolicy="no-referrer" src={source} />}
    </div>
  );
}

function FailedPreview() {
  return <p className="folder-preview-state">This file could not be loaded.</p>;
}

export function ArtifactFileView({
  capabilities,
  content,
  file,
  review,
  sidebar,
}: ArtifactFileViewProps) {
  const renderer = selectRenderer(file.mediaType, capabilities?.isolatedHtml?.origin, file.name);
  const bytes = content.status === 'ready' ? content.bytes : undefined;
  const previewUrl = content.status === 'ready' ? content.previewUrl : undefined;
  const source =
    bytes !== undefined &&
    renderer.kind !== 'docx' &&
    renderer.kind !== 'workbook' &&
    (requiresClientBytes(renderer) || supportsSourceView(file.mediaType, file.name))
      ? decodeFileSource(bytes)
      : null;

  let preview: ReactNode | undefined;
  let htmlPreview: ((theme: HtmlPreviewTheme) => ReactNode) | undefined;
  if (content.status === 'loading') {
    preview = <FileLoadingState />;
  } else if (content.status === 'failed') {
    preview = <FailedPreview />;
  } else if (renderer.kind === 'html' && capabilities?.isolatedHtml !== undefined) {
    htmlPreview = (theme) => capabilities.isolatedHtml?.render(renderer, theme);
  } else if (renderer.kind === 'image' && (previewUrl !== undefined || bytes !== undefined)) {
    preview = (
      <FileImage alt={file.name} bytes={bytes} mediaType={file.mediaType} previewUrl={previewUrl} />
    );
  } else if (renderer.kind === 'markdown' && source !== null) {
    preview = (
      <section
        aria-label="Artifact document preview"
        className="artifact-surface artifact-document"
        tabIndex={0}
      >
        <MarkdownView source={source} />
      </section>
    );
  } else if (renderer.kind === 'json' && source !== null) {
    preview = (
      <StructuredDataPreview
        fileName={file.name}
        mediaType={file.mediaType}
        showFileIdentity={false}
        showModeTabs={false}
        source={source}
      />
    );
  } else if (renderer.kind === 'table' && source !== null) {
    preview = (
      <DelimitedTablePreview
        fileName={file.name}
        mediaType={file.mediaType}
        showFileIdentity={false}
        showModeTabs={false}
        source={source}
      />
    );
  } else if (renderer.kind === 'docx' && bytes !== undefined) {
    preview = (
      <DocxPreview
        metadata={{ byteCount: bytes.byteLength, fileName: file.name, mediaType: file.mediaType }}
        src={bytes}
        title={file.name}
      />
    );
  } else if (renderer.kind === 'workbook' && bytes !== undefined) {
    preview = (
      <WorkbookPreview
        metadata={{
          byteCount: bytes.byteLength,
          fileName: file.name,
          format: 'xlsx',
          mediaType: file.mediaType,
        }}
        showFileIdentity={false}
        src={bytes}
        title={file.name}
      />
    );
  } else if (renderer.kind === 'text' && source !== null) {
    preview = <CodeView fileName={file.name} label="Artifact source preview" source={source} />;
  } else if (renderer.kind === 'pdf' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-surface artifact-pdf">
        <PdfViewer adapter={pdfJsAdapter} src={previewUrl} title="PDF preview" />
      </div>
    );
  } else if (renderer.kind === 'audio' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-surface artifact-media">
        <AudioPreview showFileIdentity={false} src={previewUrl} title={file.name} />
      </div>
    );
  } else if (renderer.kind === 'video' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-surface artifact-media">
        <VideoPreview src={previewUrl} title={file.name} />
      </div>
    );
  } else if (source === null) {
    preview = (
      <div className="artifact-surface artifact-download">
        <DownloadOnlyState fileName={file.name} mediaType={file.mediaType} />
      </div>
    );
  }

  const download = capabilities?.download;
  const toolbar = {
    download:
      download === undefined ? undefined : (
        <Button
          aria-label="Download"
          icon={DownloadSimpleIcon}
          onClick={download}
          size="sm"
          title={`Download ${file.name}`}
          type="button"
          variant="primary"
        >
          <span className="file-view-download-label">Download</span>
        </Button>
      ),
    formatLabel: formatFileType(file.name, file.mediaType),
  };

  return (
    <FileView
      defaultMode={prefersSourceView(file.mediaType, file.name) ? 'source' : 'preview'}
      fileName={file.name}
      {...(htmlPreview === undefined ? {} : { htmlPreview })}
      key={file.id}
      preview={preview}
      review={review}
      {...(sidebar === undefined
        ? {}
        : {
            onOpenSidebar: sidebar.onToggle,
            sidebarControlsId: sidebar.controlsId,
            sidebarLabel: sidebar.label,
            sidebarOpen: sidebar.open,
          })}
      {...(source === null ? {} : { source })}
      toolbar={toolbar}
    />
  );
}
