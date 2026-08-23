import { describe, expect, it } from 'vitest';

import { mediaTypeForPath } from '../src/media-type.js';

const formatCases = [
  ['diagram.SVG', 'image/svg+xml'],
  ['document.pdf', 'application/pdf'],
  ['config.yaml', 'application/yaml'],
  ['config.YML', 'application/yaml'],
  ['data.json', 'application/json'],
  ['data.geojson', 'application/geo+json'],
  ['data.jsonld', 'application/ld+json'],
  ['data.jsonl', 'application/x-ndjson'],
  ['data.ndjson', 'application/x-ndjson'],
  ['data.jsonpatch', 'application/json-patch+json'],
  ['data.mergepatch', 'application/merge-patch+json'],
  ['data.topojson', 'application/json'],
  ['bundle.map', 'application/json'],
  ['table.csv', 'text/csv'],
  ['table.tsv', 'text/tab-separated-values'],
  ['image.avif', 'image/avif'],
  ['song.mp3', 'audio/mpeg'],
  ['song.m4a', 'audio/mp4'],
  ['song.aac', 'audio/aac'],
  ['song.ogg', 'audio/ogg'],
  ['song.oga', 'audio/ogg'],
  ['song.wav', 'audio/wav'],
  ['song.flac', 'audio/flac'],
  ['song.opus', 'audio/opus'],
  ['clip.mp4', 'video/mp4'],
  ['clip.m4v', 'video/x-m4v'],
  ['clip.webm', 'video/webm'],
  ['clip.ogv', 'video/ogg'],
  ['clip.mov', 'video/quicktime'],
  ['letter.doc', 'application/msword'],
  ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['letter.odt', 'application/vnd.oasis.opendocument.text'],
  ['letter.rtf', 'application/rtf'],
  ['budget.xls', 'application/vnd.ms-excel'],
  ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['budget.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['slides.ppt', 'application/vnd.ms-powerpoint'],
  ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['slides.odp', 'application/vnd.oasis.opendocument.presentation'],
  ['archive.zip', 'application/zip'],
  ['archive.tar', 'application/x-tar'],
  ['archive.tar.gz', 'application/gzip'],
  ['archive.GZ', 'application/gzip'],
  ['archive.tgz', 'application/gzip'],
  ['archive.7z', 'application/x-7z-compressed'],
  ['font.woff', 'font/woff'],
  ['font.woff2', 'font/woff2'],
  ['font.ttf', 'font/ttf'],
  ['font.otf', 'font/otf'],
  ['styles.css', 'text/css'],
  ['script.mjs', 'text/javascript'],
  ['component.tsx', 'text/typescript'],
  ['query.sql', 'text/plain'],
  ['script.sh', 'application/x-sh'],
  ['settings.toml', 'text/plain'],
  ['settings.ini', 'text/plain'],
  ['README.md', 'text/markdown'],
  ['notes.txt', 'text/plain'],
  ['.env.production', 'text/plain'],
  ['Dockerfile', 'text/plain'],
] as const;

describe('mediaTypeForPath', () => {
  it.each(formatCases)('maps %s to %s', (path, expected) => {
    expect(mediaTypeForPath(path)).toBe(expected);
  });

  it('matches extensions without regard to path or extension case', () => {
    expect(mediaTypeForPath('fixtures/Images/PHOTO.JpG')).toBe('image/jpeg');
    expect(mediaTypeForPath('fixtures\u005cAUDIO\u005cTRACK.MP3')).toBe('audio/mpeg');
  });

  it.each(['artifact.bin', 'artifact.custom', 'README', '.unknown'])(
    'falls back to application/octet-stream for unknown path %s',
    (path) => {
      expect(mediaTypeForPath(path)).toBe('application/octet-stream');
    },
  );
});
