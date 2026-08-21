import { createRendererServer } from '../dist/server.js';

const shareId = `shr_${'d'.repeat(22)}`;
// Matches the viewer session token the web browser fixture server issues for protected shares.
const viewerToken = `${'v'.repeat(24)}.${'t'.repeat(43)}`;
const authoredHtml = `<!doctype html><html><head><title>Isolated artifact</title></head><body>
  <h1>Rendered idea</h1>
  <script>
    // Every escape attempt is individually guarded: engines disagree on
    // whether a blocked capability returns null or throws (Firefox throws in
    // places Chromium returns null), and an uncaught throw would kill the
    // script before the probe report ever posts. A throw counts as
    // containment, exactly like a null return.
    const probe = { origin: self.origin, parentReadable: false, parentStorage: false, popupOpened: false, topNavigationAssigned: false, fetchAttempted: false, xhrAttempted: false, imageAttempted: false };
    try { parent.document.body.dataset.rendererLeak = 'true'; probe.parentReadable = true; } catch {}
    try { parent.localStorage.setItem('renderer-canary', 'leaked'); probe.parentStorage = true; } catch {}
    try { fetch('https://connect-canary.invalid/leak').catch(() => {}); } catch {}
    probe.fetchAttempted = true;
    const appCanary = 'http://127.0.0.1:43873/api/v1/renderer-canary?run=' + encodeURIComponent(window.name);
    try { fetch(appCanary, { credentials: 'include' }).catch(() => {}); } catch {}
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', appCanary);
      xhr.withCredentials = true;
      xhr.send();
    } catch {}
    probe.xhrAttempted = true;
    try { const image = new Image(); image.src = 'https://image-canary.invalid/leak'; } catch {}
    probe.imageAttempted = true;
    try { probe.popupOpened = window.open('https://popup-canary.invalid/leak') !== null; } catch {}
    try { top.location = 'https://top-canary.invalid/leak'; probe.topNavigationAssigned = true; } catch {}
    parent.postMessage({ type: 'shelf:test-boundary', probe }, '*');
    addEventListener('load', () => {
      setTimeout(() => {
        parent.postMessage({ type: 'shelf:test-navigation-attempt' }, '*');
        location.href = 'https://navigation-canary.invalid/leak';
      }, 25);
    }, { once: true });
  </script>
</body></html>`;

const server = await createRendererServer({
  appOrigin: 'http://127.0.0.1:43873',
  host: '127.0.0.1',
  port: 43874,
  resolver: {
    async resolveHtml(request) {
      return request.accessType === 'protected' &&
        request.shareId === shareId &&
        request.viewerToken === viewerToken
        ? { status: 'available', html: authoredHtml }
        : { status: 'unavailable' };
    },
  },
});

await server.start();

async function stop() {
  await server.close();
  process.exitCode = 0;
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
