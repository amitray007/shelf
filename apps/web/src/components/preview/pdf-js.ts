import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { createPdfJsAdapter, type PdfJsModule } from './pdf-viewer.js';

// Keep the worker in the Vite build. A CDN worker would break self-hosted
// deployments and would make the PDF trust boundary depend on another origin.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export const pdfJsAdapter = createPdfJsAdapter(pdfjsLib as unknown as PdfJsModule);
