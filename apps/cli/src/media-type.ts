import { extname } from 'node:path';

export function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css';
    case '.csv':
      return 'text/csv';
    case '.gif':
      return 'image/gif';
    case '.htm':
    case '.html':
      return 'text/html';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
      return 'text/javascript';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ts':
    case '.tsx':
      return 'text/typescript';
    case '.txt':
      return 'text/plain';
    case '.wasm':
      return 'application/wasm';
    case '.webp':
      return 'image/webp';
    case '.xml':
      return 'application/xml';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    default:
      return 'application/octet-stream';
  }
}
