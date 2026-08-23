// Smoke matrix (user-approved 2026-08-23): per-fixture key windows/threads
// from prior analysis + full-CPU freq/sched (no hand-picked subsets).
// Every parameter change to this table requires user review first (PLAN D.0).
import {chromium} from '../../ui/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import {writeFileSync, rmSync} from 'fs';
import {execSync} from 'child_process';
const T0 = Date.now();
setTimeout(() => { console.error('HARD TIMEOUT 600s'); process.exit(3); }, 600_000);
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = ROOT + 'timeline-image-dev/results/REPORT-ASSETS/smoke/';
rmSync(OUT, {recursive: true, force: true});
import {mkdirSync} from 'fs';
mkdirSync(OUT, {recursive: true});

// User-annotated table (2026-08-23, cross-verified against trace_processor:
// slice IDs resolve to exactly the user's UI timecodes; thread names match).
// Any change requires user review (PLAN D.0).
const FIXTURES = [
  {file: 'example_android_trace.pftrace', tag: 'example', thread: {name: 'RenderThread', tid: 4543}, window: ['3428202643641', '3428410622726'], basis: 'user case G-E1 (slice[95635..115701])'},
  {file: 'smartperfetto_android_scroll_jank_customer.pftrace', tag: 'jank_customer', thread: {name: 'rcustomscroller', tid: 13534}, window: ['506731875782822', '506731991134280'], basis: 'user annotation: slice[10372 doFrame]..slice[12343 doFrame]'},
  {file: 'smartperfetto_android_scroll_standard.pftrace', tag: 'scroll_standard', thread: {name: 'rcustomscroller', tid: 12887}, window: ['271813471995031', '271813624221124'], basis: 'user annotation: slice[497 ACTION_DOWN]..slice[4875 doFrame]'},
  {file: 'smartperfetto_android_startup_heavy.pftrace', tag: 'startup_heavy', thread: {name: 'unch.aosp.heavy', tid: 21307}, window: ['564166676119845', '564168474168647'], basis: 'user annotation: slice[5937 MountEmulatedStorage]..slice[138099 MQ_Chain]'},
  {file: 'smartperfetto_android_startup_light.pftrace', tag: 'startup_light', thread: {name: '.androidappdemo', tid: 8111}, window: ['40919888981177', '40920274311663'], basis: 'user annotation: slice[5597 MountEmulatedStorage]..slice[44997 doFrame]'},
  {file: 'smartperfetto_flutter_scroll_surface_view.pftrace', tag: 'flutter_scroll', thread: {name: '1.ui', tid: 10626}, extraThread: {name: '1.raster', tid: 10627}, window: ['272267325622826', '272267492101733'], basis: 'user annotation: slice[1364 requestNextVsync]..slice[6201 CALLBACK_ANIMATION]; both threads'},
];
const rows = [];
for (const f of FIXTURES) {
  try { execSync('pkill -f "trace_processor_shell -D"'); } catch {}
  execSync('sleep 1');
  execSync('nohup ./out/mac.release/trace_processor_shell -D > timeline-image-dev/results/native-tp.log 2>&1 &', {cwd: ROOT});
  execSync('sleep 2');
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  await page.goto('http://127.0.0.1:10000/?testing=1');
  const input = await page.waitForSelector('input.trace_file', {state: 'attached', timeout: 30000});
  await input.setInputFiles(ROOT + 'test/data/' + f.file);
  await page.waitForFunction(() => {
    if (!(window.ctx && window.ctx.traceInfo)) return false;
    let n = 0; const walk = (x) => { if (x.uri) n++; for (const c of x.children) walk(c); };
    walk(window.ctx.defaultWorkspace.tracks); return n > 20;
  }, null, {timeout: 180000});
  await page.waitForTimeout(2000);
  const res = await page.evaluate(async (spec) => {
    // Collect ALL cpu freq/sched URIs actually present (no hand-picked subset).
    const uris = [];
    const walk = (n) => {
      if (n.uri && (/^\/cpu_freq_/.test(n.uri) || /^\/sched_/.test(n.uri))) uris.push(n.uri);
      for (const c of n.children) walk(c);
    };
    walk(window.ctx.defaultWorkspace.tracks);
    const threadUris = [];
    const walk2 = (n) => { if (n.uri && n.headless) threadUris.push(n.uri); for (const c of n.children) walk2(c); };
    walk2(window.ctx.defaultWorkspace.tracks);
    const shot = async (opts, tag) => {
      const r = await window.ctx.timelineImage.renderTimelineImage(opts);
      const bmp = await createImageBitmap(r.blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const colors = new Set();
      for (let i = 0; i < d.length; i += 400 * 4) colors.add(`${d[i]},${d[i+1]},${d[i+2]}`);
      const ab = await r.blob.arrayBuffer();
      const u8 = new Uint8Array(ab);
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return {w: r.width, h: r.height, tracks: r.trackBoxes.length, warn: [...r.warnings],
        colors: colors.size, ms: Math.round(r.perf.elapsedMs), b64: btoa(bin), tag,
        head: r.trackBoxes.slice(0, 3).map((b) => b.name)};
    };
    const out = [];
    // S1 (zero-arg default) removed: selection is explicit by design.
    // S2 key-window set (user-approved): full-CPU freq+sched + key thread(s).
    // Resolve thread group URIs by "<name> <tid>" title (in-page discovery;
    // the API itself only accepts URIs).
    const threadGroups = [];
    const findThreads = (n) => {
      for (const t of [spec.thread].concat(spec.extraThread ? [spec.extraThread] : [])) {
        if (n.uri && n.headless && n.name === `${t.name} ${t.tid}`) threadGroups.push(n.uri);
      }
      for (const c of n.children) findThreads(c);
    };
    findThreads(window.ctx.defaultWorkspace.tracks);
    // Browser-default order (freq group, sched group, ..., thread groups):
    // no pinning — trackUris follow the workspace tree order.
    out.push(await shot({
      trackUris: uris.concat(threadGroups),
      timeSpan: {start: spec.window[0], end: spec.window[1]},
      widthPx: 1600, devicePixelRatio: 1,
    }, 'tuned'));
    return {uris, tuned: out[0]};
  }, f);
  await browser.close();
  {
    const r = res.tuned;
    writeFileSync(`${OUT}${f.tag}-tuned.png`, Buffer.from(r.b64, 'base64'));
    rows.push({fixture: f.tag, case: 'tuned', basis: f.basis, w: r.w, h: r.h, tracks: r.tracks,
      warn: r.warn, colors: r.colors, ms: r.ms, head: r.head});
  }
  console.log(`${f.tag}: tuned ${res.tuned.w}x${res.tuned.h} ${res.tuned.tracks}t warn=${JSON.stringify(res.tuned.warn)} head=${JSON.stringify(res.tuned.head)}`);
}
writeFileSync(OUT + 'smoke.json', JSON.stringify(rows, null, 1));
console.log(`TOTAL ${((Date.now() - T0) / 1000).toFixed(0)}s`);
process.exit(0);
