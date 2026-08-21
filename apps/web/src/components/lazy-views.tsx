import { type ComponentProps, lazy, Suspense } from 'react';

import { FileLoadingState } from './file-view.js';
import type { FolderBrowser } from './folder-browser.js';
import type { MarkdownView } from './markdown-view.js';

// The markdown pipeline and the folder browser are the two heaviest passive
// renderers. Loading them on demand keeps routes that never render them from
// paying for them.
const MarkdownViewImpl = lazy(async () => ({
  default: (await import('./markdown-view.js')).MarkdownView,
}));
const FolderBrowserImpl = lazy(async () => ({
  default: (await import('./folder-browser.js')).FolderBrowser,
}));

export function LazyMarkdownView(props: ComponentProps<typeof MarkdownView>) {
  return (
    <Suspense fallback={<FileLoadingState />}>
      <MarkdownViewImpl {...props} />
    </Suspense>
  );
}

export function LazyFolderBrowser(props: ComponentProps<typeof FolderBrowser>) {
  return (
    <Suspense fallback={<FileLoadingState />}>
      <FolderBrowserImpl {...props} />
    </Suspense>
  );
}
