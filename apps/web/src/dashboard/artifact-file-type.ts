export type ArtifactFileType =
  | 'archive'
  | 'audio'
  | 'code'
  | 'data'
  | 'generic'
  | 'html'
  | 'image'
  | 'json'
  | 'markdown'
  | 'pdf'
  | 'text'
  | 'video';

const archiveExtensions = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);
const audioExtensions = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
const codeExtensions = new Set([
  'c',
  'cpp',
  'css',
  'go',
  'java',
  'js',
  'jsx',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
]);
const dataExtensions = new Set(['csv', 'toml', 'xml', 'yaml', 'yml']);
const imageExtensions = new Set(['avif', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const textExtensions = new Set(['log', 'rtf', 'text', 'txt']);
const videoExtensions = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);

export function artifactFileType(name: string): ArtifactFileType {
  const extension = name.toLocaleLowerCase().split('.').at(-1);
  if (extension === undefined || extension === name.toLocaleLowerCase()) return 'generic';
  if (extension === 'md' || extension === 'mdx') return 'markdown';
  if (extension === 'htm' || extension === 'html') return 'html';
  if (extension === 'json') return 'json';
  if (extension === 'pdf') return 'pdf';
  if (archiveExtensions.has(extension)) return 'archive';
  if (audioExtensions.has(extension)) return 'audio';
  if (codeExtensions.has(extension)) return 'code';
  if (dataExtensions.has(extension)) return 'data';
  if (imageExtensions.has(extension)) return 'image';
  if (textExtensions.has(extension)) return 'text';
  if (videoExtensions.has(extension)) return 'video';
  return 'generic';
}
