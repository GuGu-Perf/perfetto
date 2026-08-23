// T2.3: end-to-end postMessage demo. Serves a host page embedding the UI in
// an iframe; the host posts the trace buffer and a renderTimelineImage
// request back-to-back (the request is held until the trace is loaded) and
// receives the PNG bytes back — no page-internal scripting of the UI.
import {chromium} from '../../ui/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import {createServer} from 'http';
import {execSync} from 'child_process';

const T0 = Date.now();
const lap = (n) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${n}`);
const HARD_TIMEOUT_MS = 150_000;
setTimeout(() => { console.error(`HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s`); process.exit(3); }, HARD_TIMEOUT_MS);

const ROOT = new URL('../../', import.meta.url).pathname;
const TRACE = process.argv[2] ?? ROOT + 'test/data/smartperfetto_android_scroll_jank_customer.pftrace';
const UI = process.argv[3] ?? 'http://127.0.0.1:10000';
const OUT = ROOT + 'timeline-image-dev/results/postmessage-demo';
mkdirSync(OUT, {recursive: true});

// Institutional rule (T1.22): always start from an empty native-tp daemon —
// a preloaded trace makes the UI show a confirmation modal at boot.
try { execSync('pkill -f "trace_processor_shell -D"'); } catch {}
execSync('sleep 1');
execSync('nohup ./out/mac.release/trace_processor_shell -D > timeline-image-dev/results/native-tp.log 2>&1 &', {cwd: ROOT});
execSync('sleep 2');

const traceBuf = readFileSync(TRACE);
const HOST_PAGE = `<!doctype html><html><body style="margin:0">
<iframe id="ui" style="width:1280px;height:800px"></iframe>
<div id="status">booting</div>
<img id="shot" style="max-width:640px;display:block">
<script>
window.resultPngB64 = null;
window.err = null;
const ui = document.getElementById('ui');
ui.src = ${JSON.stringify(UI)} + '/?keep_api_open=true';
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (d === 'PONG') {
    document.getElementById('status').textContent = 'pong: posting trace + render request';
    fetch('/trace.bin').then((r) => r.arrayBuffer()).then((buffer) => {
      ev.source.postMessage({perfetto: {
        buffer, title: 'demo', keepApiOpen: true,
      }}, '*');
      ev.source.postMessage({perfetto: {
        action: 'renderTimelineImage', id: 'demo-1',
        options: {
          trackNames: [{name: 'RenderThread', tid: 13585}],
          trackUris: ['/cpu_freq_cpu0', '/sched_cpu0'],
          timeSpan: {start: '506734750000000', end: '506736000000000'},
          widthPx: 1200, devicePixelRatio: 1,
        },
      }}, '*');
    });
    return;
  }
  if (d && d.perfetto && d.perfetto.action === 'renderTimelineImageResult') {
    document.getElementById('status').textContent = 'result received';
    if (d.perfetto.error) { window.err = d.perfetto.error; return; }
    const bytes = new Uint8Array(d.perfetto.png);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    window.resultPngB64 = btoa(bin);
    window.resultMeta = {width: d.perfetto.result.width, height: d.perfetto.result.height,
      warnings: d.perfetto.result.warnings, tracks: d.perfetto.result.trackBoxes.length};
    document.getElementById('shot').src = 'data:image/png;base64,' + window.resultPngB64;
  }
});
ui.onload = () => {
  document.getElementById('status').textContent = 'iframe loaded, pinging';
  ui.contentWindow.postMessage('PING', '*');
};
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/trace.bin') {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(traceBuf);
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(HOST_PAGE);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
lap(`host page up: http://127.0.0.1:${port}`);

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
await page.goto(`http://127.0.0.1:${port}/`);
lap('host page loaded in browser');
try {
  await page.waitForFunction(() => window.resultPngB64 !== null || window.err !== null, null, {timeout: 100_000});
  lap('result received from UI iframe');
} finally {
  await page.screenshot({path: OUT + '/host-page.png'});
}
const err = await page.evaluate(() => window.err);
if (err) { console.error('REMOTE ERROR:', err); process.exit(1); }
const {b64, meta} = await page.evaluate(() => ({b64: window.resultPngB64, meta: window.resultMeta}));
writeFileSync(OUT + '/postmessage-shot.png', Buffer.from(b64, 'base64'));
lap('PNG saved: ' + OUT + '/postmessage-shot.png');
console.log('meta:', JSON.stringify(meta));
await browser.close();
server.close();
process.exit(0);
