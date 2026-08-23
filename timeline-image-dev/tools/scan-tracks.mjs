// T1.15: exhaustive track-coverage scan. For every fixture: walk the whole
// workspace recording each track's features (uri pattern, group header,
// whenDataReady coverage), render the full default composition, and
// pixel-analyze every track band. Report blank bands as suspicious (or
// expected: group header rows have no data by design).
import {chromium} from '../../ui/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import {writeFileSync, mkdirSync} from 'fs';
import {execSync} from 'child_process';

const ROOT = new URL('../../', import.meta.url).pathname;
const FIXTURES = [
  'smartperfetto_android_scroll_jank_customer.pftrace',
  'smartperfetto_android_scroll_standard.pftrace',
  'smartperfetto_android_startup_heavy.pftrace',
  'smartperfetto_android_startup_light.pftrace',
  'smartperfetto_flutter_scroll_surface_view.pftrace',
  'example_android_trace.pftrace',
];
const OUT = `${ROOT}timeline-image-dev/results/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-t1.15-scan`;
mkdirSync(OUT, {recursive: true});

function sh(cmd) { execSync(cmd, {cwd: ROOT, stdio: 'pipe'}); }
function startEmptyDaemon() {
  try { sh('pkill -f "trace_processor_shell -D"'); } catch {}
  execSync('sleep 1');
  sh('nohup ./out/mac.release/trace_processor_shell -D > timeline-image-dev/results/native-tp.log 2>&1 &');
  execSync('sleep 2');
}

const summary = [];
for (const fixture of FIXTURES) {
  startEmptyDaemon();
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:10000/?testing=1');
  const input = await page.waitForSelector('input.trace_file', {state: 'attached', timeout: 30000});
  await input.setInputFiles(`${ROOT}test/data/${fixture}`);
  await page.waitForFunction(() => {
    if (!(window.ctx && window.ctx.traceInfo)) return false;
    let any = false;
    const walk = (n) => { if (n.uri) any = true; for (const c of n.children) walk(c); };
    walk(window.ctx.defaultWorkspace.tracks);
    return any;
  }, null, {timeout: 180000});
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelectorAll('.pf-modal-backdrop').forEach((m) => m.remove()));

  const report = await page.evaluate(async () => {
    const ctx = window.ctx;
    // Feature inventory for every node in the workspace.
    const features = new Map(); // uri -> {name, headless, isSummary, hasWhenDataReady, hasRenderer}
    const walk = (n, depth) => {
      if (n.uri) {
        const t = ctx.tracks.getTrack(n.uri);
        const r = t?.renderer?.track ?? t?.renderer;
        features.set(n.uri, {
          name: n.name, depth,
          headless: !!n.headless, isSummary: !!n.isSummary,
          hasRenderer: !!r && typeof r.render === 'function',
          hasWhenDataReady: typeof r?.whenDataReady === 'function',
        });
      }
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(ctx.defaultWorkspace.tracks, 0);

    const r = await ctx.timelineImage.renderTimelineImage({
      widthPx: 1000, devicePixelRatio: 1, perTrackTimeoutMs: 60_000,
    });
    const bmp = await createImageBitmap(r.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', {willReadFrequently: true});
    x.drawImage(bmp, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height).data;
    const bg = `${img[0]},${img[1]},${img[2]}`;
    const bands = r.trackBoxes.map((b) => {
      const f = features.get(b.uri) ?? {};
      // Content-area coverage: x from 260 (past shell) to width.
      let nonBg = 0; const colors = new Set(); let total = 0;
      const y0 = Math.round(b.top), y1 = Math.min(Math.round(b.top + Math.max(b.height, 1)), c.height);
      for (let y = y0; y < y1; y++) {
        for (let px = 260; px < c.width; px += 3) {
          const i = (y * c.width + px) * 4;
          const k = `${img[i]},${img[i+1]},${img[i+2]}`;
          colors.add(k); total++;
          if (k !== bg) nonBg++;
        }
      }
      return {
        uri: b.uri, name: b.name, h: b.height, group: !!b.isGroupHeader,
        hasWhenDataReady: f.hasWhenDataReady ?? null,
        hasRenderer: f.hasRenderer ?? null,
        covPct: +(100 * nonBg / Math.max(total, 1)).toFixed(1),
        colors: colors.size,
      };
    });
    return {
      warnings: r.warnings,
      timeoutTracks: bands.filter((b) => b.covPct === 0 && b.h > 0).length,
      totalBands: bands.length,
      // Suspicious: non-group, rendered height > 0, but content area blank.
      blank: bands.filter((b) => !b.group && b.h > 0 && b.covPct === 0),
      // Group header rows are blank by design (18px title rows).
      groupRows: bands.filter((b) => b.group).length,
      // Tracks lacking warm-up coverage (no whenDataReady) among non-group.
      noWarmup: [...features.values()].filter((f) => !f.headless && !f.isSummary && !f.hasWhenDataReady).length,
    };
  });
  await browser.close();
  writeFileSync(`${OUT}/${fixture.replace(/\..*/, '')}.json`, JSON.stringify(report, null, 1));
  summary.push({fixture, wallS: +((Date.now() - t0) / 1000).toFixed(1),
    bands: report.totalBands, groupRows: report.groupRows,
    blankContent: report.blank.length, noWarmupTracks: report.noWarmup,
    warnings: report.warnings});
  console.log(`${fixture}: bands=${report.totalBands} groups=${report.groupRows} blank=${report.blank.length} noWarmup=${report.noWarmup} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (report.blank.length > 0) {
    for (const b of report.blank.slice(0, 8)) console.log(`  BLANK: ${b.uri} "${b.name}" h=${b.h} ready=${b.hasWhenDataReady}`);
  }
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
console.log('artifacts:', OUT);
