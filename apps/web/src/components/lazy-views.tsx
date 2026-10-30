import { type ComponentProps, lazy, Suspense } from 'react';

import { FileLoadingState } from './file-view.js';
import type { FolderBrowser } from './folder-browser.js';
import { lazyModule } from './lazy-module.js';
import type { MarkdownView } from './markdown-view.js';

// Keep passive renderer downloads off routes that do not use them. Resolved
// modules render synchronously on later mounts without a loading-state flash.
const MarkdownViewImpl = lazyModule(
  async () => (await import('./markdown-view.js')).MarkdownView,
  <FileLoadingState />,
);
// The folder browser stays on React.lazy until its preview frame startup is
// proven race-free without the Suspense retry delay.
const FolderBrowserImpl = lazy(async () => ({
  default: (await import('./folder-browser.js')).FolderBrowser,
}));

export function LazyMarkdownView(props: ComponentProps<typeof MarkdownView>) {
  return <MarkdownViewImpl {...props} />;
}

export function LazyFolderBrowser(props: ComponentProps<typeof FolderBrowser>) {
  return (
    <Suspense fallback={<FileLoadingState />}>
      <FolderBrowserImpl {...props} />
    </Suspense>
  );
}
