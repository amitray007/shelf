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

const folderRevisionId = `rev_${'g'.repeat(22)}`;
const folderShareId = `shr_${'f'.repeat(22)}`;
const folderSessionId = '123e4567-e89b-42d3-a456-426614174000';
const pngDot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// Folders keyed by Public code. The Protected fixture share opens the CSS folder.
const folders = {
  CssFolder123: {
    'mockup.html':
      '<!doctype html><html><head><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="https://styles-canary.invalid/leak.css"><style>h1 { font-size: 24px; }</style></head><body><h1>Styled folder mockup</h1><div class="layout"><span>Account</span><span>Quota</span></div></body></html>',
    'long.html':
      '<!doctype html><html><body><h1>Long folder document</h1><div style="height: 2400px">Long document</div><button>End of document</button></body></html>',
    'theme.css':
      ':root { color-scheme: light dark; --ink: light-dark(#2456d6, #7ea2ff); } body { color: var(--ink); background: light-dark(#fbfbfa, #0e0e0f); font: 15px system-ui; } .layout { display: grid; grid-template-columns: 100px 200px; gap: 16px; }',
  },
  SiteFolder12: {
    'index.html': `<!doctype html><html><head><title>Agent site</title>
<link rel="stylesheet" href="css/site.css">
<script src="js/classic.js"></script>
<script type="module" src="js/app.js?v=1"></script>
<script src="https://script-canary.invalid/leak.js"></script>
</head><body><h1>Agent site</h1>
<p id="classic">classic:pending</p><p id="module">module:pending</p><p id="lazy">lazy:pending</p><p id="data">data:pending</p><p id="external">external:pending</p>
<img id="dot" alt="dot" src="img/dot.png" width="8" height="8">
<nav><a id="about" href="about.html#team">About this site</a> <a id="section" href="#details">Details</a></nav>
<section id="details" style="margin-top:2000px">Details</section>
</body></html>`,
    'about.html':
      '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><h1>About page</h1><a href="index.html">Home</a></body></html>',
    'css/site.css': '@import "base.css"; body { background-image: url("../img/dot.png"); }',
    'css/base.css': 'h1 { color: rgb(1, 2, 3); }',
    'js/classic.js': 'window.classicReady = true;',
    'js/app.js': `import { label } from './util.js';
const show = (id, text) => { document.getElementById(id).textContent = text; };
show('classic', window.classicReady ? 'classic:ok' : 'classic:missing');
show('module', label);
import('./lazy.js').then((lazy) => show('lazy', lazy.label), () => show('lazy', 'lazy:failed'));
fetch('data.json').then((response) => response.json()).then((data) => show('data', data.label), () => show('data', 'data:failed'));
fetch('https://connect-canary.invalid/leak').then(() => show('external', 'external:leaked'), () => show('external', 'external:blocked'));`,
    'js/util.js': "export const label = 'module:ok';",
    'js/lazy.js': "export const label = 'lazy:ok';",
    'data.json': '{"label":"data:ok"}',
    'img/dot.png': pngDot,
  },
};
const mediaTypes = {
  css: 'text/css',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
};

function folderFor(authority) {
  if (authority.type === 'public') return folders[authority.publicCode];
  return authority.shareId === folderShareId && authority.sessionId === folderSessionId
    ? folders.CssFolder123
    : undefined;
}

const server = await createRendererServer({
  appOrigin: 'http://127.0.0.1:43873',
  host: '127.0.0.1',
  port: 43874,
  resolver: {
    async resolveHtml(request) {
      if (request.path !== undefined) {
        const authority =
          request.accessType === 'public'
            ? { type: 'public', publicCode: request.publicCode }
            : request.viewerToken === viewerToken
              ? { type: 'protected-session', shareId: request.shareId, sessionId: folderSessionId }
              : undefined;
        const file = authority === undefined ? undefined : folderFor(authority)?.[request.path];
        return typeof file === 'string' && request.path.endsWith('.html')
          ? { status: 'folder', authority, revisionId: folderRevisionId, path: request.path }
          : { status: 'unavailable' };
      }
      return request.accessType === 'protected' &&
        request.shareId === shareId &&
        request.viewerToken === viewerToken
        ? { status: 'available', html: authoredHtml }
        : { status: 'unavailable' };
    },
    async readFolderFile(request) {
      const file =
        request.revisionId === folderRevisionId
          ? folderFor(request.authority)?.[request.path]
          : undefined;
      if (file === undefined) return undefined;
      const mediaType =
        mediaTypes[request.path.split('.').at(-1) ?? ''] ?? 'application/octet-stream';
      if (mediaType === 'text/html') return { kind: 'html', html: file };
      const bytes = Buffer.from(file);
      return {
        kind: 'file',
        mediaType,
        byteCount: bytes.byteLength,
        async read(range) {
          return (async function* () {
            yield range === undefined ? bytes : bytes.subarray(range.start, range.end + 1);
          })();
        },
      };
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
