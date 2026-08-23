import {chromium} from '/Users/vinson/CodeBuddy/Claw/myPerfetto/ui/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import {writeFileSync, mkdirSync} from 'fs';
import {execSync} from 'child_process';
const T0 = Date.now();
setTimeout(() => { console.error('HARD TIMEOUT 600s'); process.exit(3); }, 600_000);
const ROOT = '/Users/vinson/CodeBuddy/Claw/myPerfetto/';
const OUT = ROOT + 'timeline-image-dev/results/REPORT-ASSETS/smoke/';
mkdirSync(OUT, {recursive: true});
const FIXTURES = ['example_android_trace.pftrace', 'smartperfetto_android_scroll_jank_customer.pftrace',
  'smartperfetto_android_scroll_standard.pftrace', 'smartperfetto_android_startup_heavy.pftrace',
  'smartperfetto_android_startup_light.pftrace', 'smartperfetto_flutter_scroll_surface_view.pftrace'];
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
  await input.setInputFiles(ROOT + 'test/data/' + f);
  await page.waitForFunction(() => {
    if (!(window.ctx && window.ctx.traceInfo)) return false;
    let n = 0; const walk = (x) => { if (x.uri) n++; for (const c of x.children) walk(c); };
    walk(window.ctx.defaultWorkspace.tracks); return n > 20;
  }, null, {timeout: 180000});
  await page.waitForTimeout(2000);
  const res = await page.evaluate(async () => {
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
        colors: colors.size, ms: Math.round(r.perf.elapsedMs), b64: btoa(bin), tag};
    };
    const full = window.ctx.timeline.visibleWindow;
    const mid = full.midpoint;
    const out = [];
    // S1 默认参数（仅定宽度）
    out.push(await shot({widthPx: 1200, devicePixelRatio: 1, perTrackTimeoutMs: 30000}, 'default'));
    // S2 常用调整：挑 cpu0-3 freq+sched + 中段 1s 窗 + 4:3（用户截窗口时的典型用法）
    out.push(await shot({
      trackUris: ['/cpu_freq_cpu0','/cpu_freq_cpu1','/cpu_freq_cpu2','/cpu_freq_cpu3',
                  '/sched_cpu0','/sched_cpu1','/sched_cpu2','/sched_cpu3'],
      timeSpan: {start: mid.toTime().toString(), end: mid.addNumber(1_000_000_000).toTime().toString()},
      aspectRatio: 4 / 3, devicePixelRatio: 1, perTrackTimeoutMs: 30000,
    }, 'tuned'));
    return out;
  });
  await browser.close();
  for (const r of res) {
    const name = `${f.replace(/\..*/, '')}-${r.tag}.png`;
    writeFileSync(OUT + name, Buffer.from(r.b64, 'base64'));
    rows.push({fixture: f.replace(/\..*/, ''), case: r.tag, ...r, b64: undefined});
  }
  console.log(`${f}: default ${res[0].w}x${res[0].h} ${res[0].tracks}t ${res[0].ms}ms warn=${JSON.stringify(res[0].warn)} | tuned ${res[1].w}x${res[1].h} ratio=${(res[1].w / res[1].h).toFixed(3)} ${res[1].tracks}t ${res[1].ms}ms warn=${JSON.stringify(res[1].warn)}`);
}
writeFileSync(OUT + 'smoke.json', JSON.stringify(rows, null, 1));
console.log(`TOTAL ${((Date.now() - T0) / 1000).toFixed(0)}s`);
process.exit(0);
