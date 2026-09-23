import { pdfJsAdapter } from './pdf-js.js';
import { PdfViewer } from './pdf-viewer.js';

export function PdfPreview({ src }: { readonly src: string }) {
  return <PdfViewer adapter={pdfJsAdapter} src={src} title="PDF preview" />;
}
