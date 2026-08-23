import { Empty } from '@cloudflare/kumo/components/empty';
import { FileDashedIcon } from '@phosphor-icons/react/FileDashed';

type DownloadOnlyCategory = 'archive' | 'font' | 'office' | 'binary' | 'generic';

const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);
const FONT_EXTENSIONS = new Set(['eot', 'otf', 'ttf', 'woff', 'woff2']);
const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docm',
  'docx',
  'dot',
  'dotm',
  'dotx',
  'odp',
  'ods',
  'odt',
  'pot',
  'potm',
  'potx',
  'pps',
  'ppsm',
  'ppsx',
  'ppt',
  'pptm',
  'pptx',
  'sldm',
  'sldx',
  'xls',
  'xlam',
  'xlsb',
  'xlsm',
  'xlsx',
  'xlt',
  'xltm',
  'xltx',
]);

const ARCHIVE_MEDIA_TYPES = new Set([
  'application/7z',
  'application/gzip',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'application/x-gzip',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/x-xz',
  'application/zip',
]);
const FONT_MEDIA_TYPES = new Set([
  'application/font-sfnt',
  'application/vnd.ms-fontobject',
  'application/x-font-opentype',
  'application/x-font-ttf',
  'font/otf',
  'font/ttf',
  'font/woff',
  'font/woff2',
]);
const OFFICE_MEDIA_TYPES = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
]);
const BINARY_MEDIA_TYPES = new Set([
  '',
  'application/binary',
  'application/octet-stream',
  'application/x-binary',
  'binary/octet-stream',
]);

function fileExtension(fileName: string | undefined): string {
  if (fileName === undefined) return '';
  const leaf = fileName.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot <= 0 ? '' : leaf.slice(dot + 1).toLowerCase();
}

function normalizedMediaType(mediaType: string | undefined): string {
  return mediaType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function classifyDownloadOnly(
  fileName: string | undefined,
  mediaType: string | undefined,
): DownloadOnlyCategory {
  const extension = fileExtension(fileName);
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  if (FONT_EXTENSIONS.has(extension)) return 'font';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (extension === 'bin') return 'binary';

  const normalized = normalizedMediaType(mediaType);
  if (ARCHIVE_MEDIA_TYPES.has(normalized)) return 'archive';
  if (FONT_MEDIA_TYPES.has(normalized)) return 'font';
  if (
    OFFICE_MEDIA_TYPES.has(normalized) ||
    normalized.startsWith('application/vnd.ms-') ||
    normalized.startsWith('application/vnd.oasis.opendocument.') ||
    normalized.startsWith('application/vnd.openxmlformats-officedocument.')
  )
    return 'office';
  if (BINARY_MEDIA_TYPES.has(normalized)) return 'binary';
  return 'generic';
}

const DESCRIPTIONS: Readonly<Record<DownloadOnlyCategory, string>> = {
  archive: 'Download the archive to open its contents.',
  binary: 'Download this file to open it with a compatible app.',
  font: 'Download the font to install or use it.',
  generic: 'Download this file to open it.',
  office: 'Download this file to open it in an Office app.',
};

export function DownloadOnlyState({
  fileName,
  mediaType,
}: {
  readonly fileName?: string | undefined;
  readonly mediaType?: string | undefined;
}) {
  return (
    <Empty
      className="download-only-state"
      description={DESCRIPTIONS[classifyDownloadOnly(fileName, mediaType)]}
      icon={<FileDashedIcon aria-hidden="true" size={24} />}
      size="sm"
      title="Preview unavailable"
    />
  );
}
