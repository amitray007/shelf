import { FileLoadingState } from './file-view.js';
import { lazyModule } from './lazy-module.js';

// Each import stays behind the renderer selection in ArtifactFileView.
export const ImagePreview = lazyModule(
  async () => (await import('./preview/image-preview.js')).ImagePreview,
  <FileLoadingState />,
);
export const StructuredDataPreview = lazyModule(
  async () => (await import('./preview/structured-data-preview.js')).StructuredDataPreview,
  <FileLoadingState />,
);
export const DelimitedTablePreview = lazyModule(
  async () => (await import('./preview/delimited-table-preview.js')).DelimitedTablePreview,
  <FileLoadingState />,
);
export const DocxPreview = lazyModule(
  async () => (await import('./preview/office-document-preview.js')).DocxPreview,
  <FileLoadingState />,
);
export const WorkbookPreview = lazyModule(
  async () => (await import('./preview/workbook-preview.js')).WorkbookPreview,
  <FileLoadingState />,
);
export const PdfPreview = lazyModule(
  async () => (await import('./preview/pdf-preview.js')).PdfPreview,
  <FileLoadingState />,
);
export const AudioPreview = lazyModule(
  async () => (await import('./preview/media-preview.js')).AudioPreview,
  <FileLoadingState />,
);
export const VideoPreview = lazyModule(
  async () => (await import('./preview/media-preview.js')).VideoPreview,
  <FileLoadingState />,
);
