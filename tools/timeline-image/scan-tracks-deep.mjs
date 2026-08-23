import {chromium} from '../../ui/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import {writeFileSync, mkdirSync} from 'fs';
import {execSync} from 'child_process';
const OUT = new URL('../../', import.meta.url).pathname + 'out/test-runs/' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '-t1.15-scan-deep';
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
await page.goto('http://127.0.0.1:10000/?testing=1');
const input = await page.waitForSelector('input.trace_file', {state: 'attached', timeout: 30000});
await input.setInputFiles('new URL('../../', import.meta.url).pathname + 'test/data/smartperfetto_android_scroll_jank_customer.pftrace'');
await page.waitForFunction(() => {
  if (!(window.ctx && window.ctx.traceInfo)) return false;
  let n = 0; const walk = (x) => { if (x.uri && !x.headless && !x.isSummary) n++; for (const c of x.children) walk(c); };
  walk(window.ctx.defaultWorkspace.tracks);
  return n > 1000; // full tree built
}, null, {timeout: 180000});
await page.waitForTimeout(2500);
const result = await page.evaluate(async () => {
  const ctx = window.ctx;
  // All leaf (non-group) URIs in tree order.
  const leafUris = [];
  const walk = (n) => {
    const isGroup = n.isSummary || n.headless;
    if (!isGroup && n.uri) leafUris.push(n.uri);
    for (const c of n.children) walk(c);
  };
  walk(ctx.defaultWorkspace.tracks);
  // Render in batches sized to stay under the canvas guardrail (~30px/track, keep 5000px height).
  const BATCH = 500;
  const batches = [];
  for (let i = 0; i < leafUris.length; i += BATCH) batches.push(leafUris.slice(i, i + BATCH));
  const analyze = async (r) => {
    const bmp = await createImageBitmap(r.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', {willReadFrequently: true});
    x.drawImage(bmp, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height).data;
    const bg = `${img[0]},${img[1]},${img[2]}`;
    return r.trackBoxes.filter((b) => b.height > 0).map((b) => {
      let nonBg = 0, total = 0;
      const y0 = Math.round(b.top), y1 = Math.min(Math.round(b.top + b.height), c.height);
      for (let y = y0; y < y1; y++) for (let px = 260; px < c.width; px += 3) {
        const i = (y * c.width + px) * 4;
        if (`${img[i]},${img[i+1]},${img[i+2]}` !== bg) nonBg++;
        total++;
      }
      return {uri: b.uri, name: b.name, covPct: +(100 * nonBg / Math.max(total, 1)).toFixed(1)};
    });
  };
  const all = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const r = await ctx.timelineImage.renderTimelineImage({
      trackUris: batches[bi], widthPx: 1000, devicePixelRatio: 1, perTrackTimeoutMs: 60_000,
    });
    console.log('batch', bi, 'boxes=', r.trackBoxes.length, 'h=', r.height, 'warn=', JSON.stringify(r.warnings));
    const bands = await analyze(r);
    console.log('batch', bi, 'bands=', bands.length);
    all.push(...bands.map((b) => ({...b, batch: bi})));
  }
  const low = all.filter((b) => b.covPct > 0 && b.covPct < 0.5);
  return {leafTotal: leafUris.length, rendered: all.length,
    blank: all.filter((b) => b.covPct === 0),
    lowCov: low.length, lowSample: low.slice(0, 12),
    covHistogram: {
      zero: all.filter((b) => b.covPct === 0).length,
      lt05: low.length,
      '05to5': all.filter((b) => b.covPct >= 0.5 && b.covPct < 5).length,
      '5to30': all.filter((b) => b.covPct >= 5 && b.covPct < 30).length,
      gt30: all.filter((b) => b.covPct >= 30).length,
    }};
});
writeFileSync(OUT + '/jank-customer-deep-all-leaves.json', JSON.stringify(result, null, 1));
console.log(`leaves=${result.leafTotal} rendered=${result.rendered} blank=${result.blank.length} lowCov(<0.5%)=${result.lowCov}`);
for (const b of result.blank.slice(0, 20)) console.log(`  BLANK: ${b.uri} "${b.name}"`);
await browser.close();
