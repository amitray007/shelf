// Entry loaded by the share document ahead of the main bundle, so the first share request
// leaves while that bundle is still downloading. The main bundle imports it too, which reuses
// this module instance instead of starting again.
import { prefetchShareOpen } from './share-requests.js';

prefetchShareOpen();
