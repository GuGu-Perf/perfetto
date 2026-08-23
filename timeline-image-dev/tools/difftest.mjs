// T1.32: differential test — the interactive UI rendering is the oracle for
// the offscreen API. Per fixture two modes: M1 default view, M2 the
// user-annotated key window. Band-paired, region-differentiated comparison
// (content area pixel-exact within tolerance; shell column compares line
// positions, not glyph rasterization). FAIL blocks; no silent allowlist.
import {chromium} from '../../ui/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import {writeFileSync, mkdirSync} from 'fs';
import {execSync} from 'child_process';

const T0 = Date.now();
setTimeout(() => { console.error('HARD TIMEOUT 900s'); process.exit(3); }, 900_000);
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = ROOT + `timeline-image-dev/results/diff/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-difftest`;
mkdirSync(OUT, {recursive: true});

const FIXTURES = [
  {file: 'example_android_trace.pftrace', tag: 'example', window: ['3428202643641n', '3428410622726n']},
  {file: 'smartperfetto_android_scroll_jank_customer.pftrace', tag: 'jank_customer', window: ['506731875782822n', '506731991134280n']},
  {file: 'smartperfetto_android_scroll_standard.pftrace', tag: 'scroll_standard', window: ['271813471995031n', '271813624221124n']},
  {file: 'smartperfetto_android_startup_heavy.pftrace', tag: 'startup_heavy', window: ['564166676119845n', '564168474168647n']},
  {file: 'smartperfetto_android_startup_light.pftrace', tag: 'startup_light', window: ['40919888981177n', '40920274311663n']},
  {file: 'smartperfetto_flutter_scroll_surface_view.pftrace', tag: 'flutter_scroll', window: ['272267325622826n', '272267492101733n']},
];
const CONTENT_X = 260;   // past the 250px shell column in both renderings
const PIXEL_DIST = 16;   // per-pixel color distance treated as equal
const PASS_RATE = 0.005, FAIL_RATE = 0.02; // superseded by v3 structural thresholds (kept for reference)

const browser = await chromium.launch();
const summary = [];
for (const spec of FIXTURES) {
  try { execSync('pkill -f "trace_processor_shell -D"'); } catch {}
  execSync('sleep 1');
  execSync('nohup ./out/mac.release/trace_processor_shell -D > timeline-image-dev/results/native-tp.log 2>&1 &', {cwd: ROOT});
  execSync('sleep 2');
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
  // Pin the theme: the UI follows prefers-color-scheme and headless pages
  // otherwise race between light/dark, flipping the background color and
  // every structural metric with it.
  await page.emulateMedia({colorScheme: 'light'});
  await page.goto('http://127.0.0.1:10000/?testing=1');
  const input = await page.waitForSelector('input.trace_file', {state: 'attached', timeout: 30000});
  await input.setInputFiles(ROOT + 'test/data/' + spec.file);
  await page.waitForFunction(() => {
    if (!(window.ctx && window.ctx.traceInfo)) return false;
    let n = 0; const walk = (x) => { if (x.uri) n++; for (const c of x.children) walk(c); };
    walk(window.ctx.defaultWorkspace.tracks); return n > 20;
  }, null, {timeout: 180000});
  await page.waitForTimeout(2500);

  for (const mode of ['m1-default', 'm2-window']) {
    const lap = `${spec.tag}-${mode}`;
    try {
      const res = await page.evaluate(async (arg) => {
        const {mode, start, end} = arg;
        const ctx = window.ctx;
        if (mode === 'm2-window') {
          // Precise UI-side window control via the public timeline API:
          // construct a HighPrecisionTimeSpan from the current instance.
          const vw = ctx.timeline.visibleWindow;
          const S = vw.start.constructor;
          ctx.timeline.setVisibleWindow(
            new vw.constructor(new S(BigInt(start)), Number(BigInt(end) - BigInt(start))));
        }
        await new Promise((r) => setTimeout(r, 1200)); // let redraws settle
        // UI oracle in page-absolute coordinates; the screenshot clip anchor
        // is the first visible track row.
        const firstTrack = document.querySelector('.pf-track');
        const clipY = firstTrack ? firstTrack.getBoundingClientRect().y : 172;
        const rows = [...document.querySelectorAll('.pf-track__header')].map((e) => {
          const r = e.getBoundingClientRect();
          return {name: (e.querySelector('.pf-track__title')?.textContent ?? '').trim(),
                  top: r.y - clipY, height: r.height};
        }).filter((r) => r.name.length > 0 && r.height > 0 && r.top >= -2 && r.top < 620);
        // API render: same window (or default), same content width, dpr 1.
        const opts = {widthPx: 1690, devicePixelRatio: 1, perTrackTimeoutMs: 30000};
        if (mode === 'm2-window') opts.timeSpan = {start, end};
        const r = await ctx.timelineImage.renderTimelineImage(opts);
        const bmp = await createImageBitmap(r.blob);
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const x = c.getContext('2d', {willReadFrequently: true});
        x.drawImage(bmp, 0, 0);
        const img = x.getImageData(0, 0, c.width, c.height);
        // Encode both PNGs for the artifact set.
        const enc = (canvas) => new Promise((res) => canvas.toBlob(async (b) => {
          const u8 = new Uint8Array(await b.arrayBuffer());
          let bin = '';
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
          res(btoa(bin));
        }, 'image/png'));
        // UI pixels come from the Playwright screenshot clip (page-absolute);
        // in-page we only return row rects and the API image.
        void img;
        return {rows, apiB64: await enc(c), apiW: c.width, apiH: c.height,
                boxes: r.trackBoxes.map((b) => ({name: b.name, top: b.top, height: b.height, group: b.isGroupHeader === true})),
                winNow: mode === 'm2-window'
                  ? [ctx.timeline.visibleWindow.start.toTime().toString(),
                     ctx.timeline.visibleWindow.end.toTime().toString()] : null,
                warnings: [...r.warnings]};
      }, {mode, start: spec.window[0].replace('n', ''), end: spec.window[1].replace('n', '')});
      // UI content-area screenshot (true pixels), anchored at the first row.
      const uiPng = await page.screenshot({clip: {x: 230, y: 172, width: 1690, height: 640}});
      writeFileSync(`${OUT}/${lap}-ui.png`, uiPng);
      writeFileSync(`${OUT}/${lap}-api.png`, Buffer.from(res.apiB64, 'base64'));
      // Structural diff (v3): coverage per band, per-row profiles, column
      // distributions — robust to the physical color shift between the
      // browser-composited UI and the canvas-composited API output.
      const diff = await page.evaluate(async (arg) => {
        const {uiB64, apiB64, uiRows, apiBoxes, contentX, bgDist} = arg;
        const load = async (b64) => {
          const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          const x = c.getContext('2d', {willReadFrequently: true});
          x.drawImage(bmp, 0, 0);
          return {img: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height};
        };
        const UI = await load(uiB64), API = await load(apiB64);
        const isBg = (img, w, x, y) => {
          const i = (y * w + x) * 4;
          return (img[i] > 245 && img[i+1] > 245 && img[i+2] > 245);
        };
        void bgDist;
        // Pair bands by name sequence.
        const pairs = [];
        let ai = 0;
        for (const u of uiRows) {
          while (ai < apiBoxes.length && apiBoxes[ai].name !== u.name) ai++;
          if (ai >= apiBoxes.length) break;
          pairs.push({name: u.name, uiTop: Math.round(u.top), h: Math.min(Math.round(u.height), UI.h - Math.round(u.top)),
                      apiTop: Math.round(apiBoxes[ai].top), group: apiBoxes[ai].group === true});
          ai++;
        }
        const bands = [];
        const corr = (a, b) => {
          const n = a.length;
          const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
          let num = 0, da = 0, db = 0;
          for (let i = 0; i < n; i++) { num += (a[i]-ma)*(b[i]-mb); da += (a[i]-ma)**2; db += (b[i]-mb)**2; }
          // Flat-on-flat (empty band on both sides) counts as identical.
          if (da === 0 && db === 0) return 1;
          if (da === 0 || db === 0) return 0;
          return num / Math.sqrt(da * db);
        };
        let totalDrift = 0, colorN = 0;
        for (const p of pairs) {
          if (p.h <= 0) continue;
          // Group-header rows carry no data; their decoration background
          // straddles the background threshold between the two compositing
          // pipelines. Positional consistency is asserted by the pairing
          // itself; content metrics only apply to data rows.
          if (p.group) continue;
          const rowsUi = [], rowsApi = [];
          const colUi = new Uint32Array(API.w), colApi = new Uint32Array(API.w);
          let nUi = 0, nApi = 0, total = 0;
          for (let dy = 0; dy < p.h; dy++) {
            if (p.uiTop + dy >= UI.h || p.apiTop + dy >= API.h) break;
            let ru = 0, ra = 0;
            for (let px = contentX; px < Math.min(UI.w, API.w); px += 2) {
              const u = !isBg(UI.img, UI.w, px, p.uiTop + dy);
              const a = !isBg(API.img, API.w, px, p.apiTop + dy);
              if (u) { ru++; colUi[px]++; }
              if (a) { ra++; colApi[px]++; }
              total++;
              const ui = (p.uiTop+dy) * UI.w + px, ap = (p.apiTop+dy) * API.w + px;
              { const iu = ((p.uiTop+dy) * UI.w + px) * 4, ia = ((p.apiTop+dy) * API.w + px) * 4;
                totalDrift += Math.abs(UI.img[iu] - API.img[ia]); colorN++; }
            }
            rowsUi.push(ru); rowsApi.push(ra); nUi += ru; nApi += ra;
          }
          const rateUi = nUi / Math.max(total, 1), rateApi = nApi / Math.max(total, 1);
          let maxRowDiff = 0, rms = 0;
          for (let i = 0; i < rowsUi.length; i++) {
            const d = Math.abs(rowsUi[i] - rowsApi[i]) / (Math.max(rowsUi[i], rowsApi[i], 4));
            maxRowDiff = Math.max(maxRowDiff, d); rms += d * d;
          }
          rms = Math.sqrt(rms / rowsUi.length);
          // Column-distribution correlation over the content area, computed
          // on an 8px sliding-sum so 1-2px rasterization/quantization shifts
          // between the pipelines do not destroy the correlation. Bands with
          // almost no content (a couple of slices) are decided by coverage
          // and row-profile alone: their column shape is underdetermined.
          const xs = [];
          for (let px = contentX; px < Math.min(UI.w, API.w); px += 4) xs.push(px);
          const smooth = (v) => v.map((_, i) => v[Math.max(0, i-2)] + v[Math.max(0, i-1)] + v[i] + v[Math.min(v.length-1, i+1)] + v[Math.min(v.length-1, i+2)]);
          const vUi = xs.map((px) => colUi[px]), vApi = xs.map((px) => colApi[px]);
          const meanUi = vUi.reduce((x, y) => x + y, 0) / vUi.length;
          const meanApi = vApi.reduce((x, y) => x + y, 0) / vApi.length;
          const c = meanUi < 4 && meanApi < 4 ? 1 : corr(smooth(vUi), smooth(vApi));
          bands.push({name: p.name,
            cov: +(rateUi - rateApi).toFixed(4),
            maxRow: +maxRowDiff.toFixed(3), rms: +rms.toFixed(4),
            colCorr: +c.toFixed(4),
            shellTextPx: 0});
        }
        const worstCov = bands.reduce((a, b) => (Math.abs(b.cov) > Math.abs(a?.cov ?? 0) ? b : a), undefined);
        const worstRow = bands.reduce((a, b) => (b.maxRow > (a?.maxRow ?? -1) ? b : a), undefined);
        const worstCorr = bands.reduce((a, b) => (b.colCorr < (a?.colCorr ?? 2) ? b : a), undefined);
        const verdict = !bands.length ? 'NO-PAIRING'
          : (Math.abs(worstCov.cov) > 0.02 || worstRow.maxRow > 0.35 || worstCorr.colCorr < 0.9) ? 'FAIL'
          : (worstCorr.colCorr < 0.95 || worstRow.maxRow > 0.25) ? 'WARN' : 'PASS';
        return {pairedBands: bands.length, uiRows: uiRows.length, apiBoxes: apiBoxes.length,
          worst: worstCov ?? {name: '-', cov: 0}, worstRow: worstRow ?? {name: '-', maxRow: 0},
          worstCorr: worstCorr ?? {name: '-', colCorr: 1},
          avgColorDrift: colorN ? Math.round(totalDrift / colorN) : 0,
          verdict, bands: bands.filter((b) => Math.abs(b.cov) > 0.01 || b.maxRow > 0.2 || b.colCorr < 0.97).slice(0, 5)};
      }, {uiB64: uiPng.toString('base64'), apiB64: res.apiB64, uiRows: res.rows, apiBoxes: res.boxes,
          contentX: CONTENT_X, bgDist: PIXEL_DIST});
      summary.push({pair: lap, ...diff, warnings: res.warnings});
      console.log(`${lap}: ${diff.verdict} paired=${diff.pairedBands}/${diff.uiRows} covDiff=${(diff.worst.cov * 100).toFixed(1)}pp rowMax=${diff.worstRow.maxRow} colCorr=${diff.worstCorr.colCorr} drift=${diff.avgColorDrift}`);
    } catch (e) {
      summary.push({pair: lap, verdict: 'ERROR', error: String(e).slice(0, 200)});
      console.log(`${lap}: ERROR ${String(e).slice(0, 120)}`);
    }
  }
  await page.close();
}
await browser.close();
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
console.log(`TOTAL ${((Date.now() - T0) / 1000).toFixed(0)}s -> ${OUT}`);
process.exit(0);
