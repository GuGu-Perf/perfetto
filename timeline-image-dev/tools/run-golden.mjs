// Golden-scenario runner for trace.timelineImage.renderTimelineImage().
// Institutional rules (plan v9.12, T1.13/T1.22/T1.24):
//  - Scenario parameters are FROZEN in SCENARIOS below; deliverables only
//    ever come from these entries (no ad-hoc hand-built parameters).
//  - Every run: fresh empty native-tp daemon (no preloaded-trace popup),
//    workspace-readiness wait, modal auto-dismiss safety net, engine
//    evidence, six-piece artifacts (png/metadata/ui-reference/engine/
//    run.json/log) under timeline-image-dev/results/<ts>-golden-<scenario>/.
import {chromium} from '../../ui/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import {writeFileSync, mkdirSync, readFileSync, symlinkSync, rmSync, existsSync} from 'fs';
import {execSync} from 'child_process';

const ROOT = new URL('../../', import.meta.url).pathname;
const JANK_TRACE = ROOT + 'test/data/smartperfetto_android_scroll_jank_customer.pftrace';
const EXAMPLE_TRACE = ROOT + 'test/data/example_android_trace.pftrace';

// Frozen golden scenarios. G-STD is the user-approved standard working set
// (step2 parameters); G-DEFAULT is the zero-argument API semantics (the
// whole default workspace, order asserted against the live UI in the spec).
const A2_WINDOW = {start: '506734750000000', end: '506736000000000'};
const SCENARIOS = {
  'G-STD': {
    description: 'User standard working set: RenderThread pinned first, cpu0-3 freq+sched, jank window',
    opts: {
      trackUris: ['/cpu_freq_cpu0','/cpu_freq_cpu1','/cpu_freq_cpu2','/cpu_freq_cpu3',
                  '/sched_cpu0','/sched_cpu1','/sched_cpu2','/sched_cpu3','/thread_7303'],
      pinTracks: ['/thread_7303'],
      timeSpan: A2_WINDOW,
      widthPx: 1800, devicePixelRatio: 1, perTrackTimeoutMs: 20000,
    },
    uiRefClip: {x: 230, y: 114, width: 1690, height: 256},
  },
  'G-DEFAULT': {
    description: 'Zero-argument API default: the whole default workspace in UI order',
    opts: {widthPx: 1800, devicePixelRatio: 1, perTrackTimeoutMs: 30000},
    uiRefClip: {x: 230, y: 114, width: 1690, height: 340},
  },
  // User-authored case (v9.14): example trace, window spanned by
  // slice[95635] (dispatchFrameCallbacks) .. slice[115701] (DrawFrames),
  // both on RenderThread tid 4543 (utid 75); RenderThread pinned first;
  // standard mode = all cpus' freq + sched groups in UI order; landscape
  // 4:3 (width = height * 4/3; the API derives height from tracks, so the
  // ratio is realized by solving for widthPx).
  'G-E1': {
    trace: EXAMPLE_TRACE,
    workspaceMarker: '/thread_75',
    description: 'User case: example trace, slice[95635]..slice[115701] window, RenderThread 4543 pinned, standard mode, 4:3 (native API trackNames + aspectRatio)',
    opts: {
      trackUris: ['/cpu_freq_cpu0','/cpu_freq_cpu1','/cpu_freq_cpu2','/cpu_freq_cpu3',
                  '/cpu_freq_cpu4','/cpu_freq_cpu5','/cpu_freq_cpu6','/cpu_freq_cpu7',
                  '/cpu_freq_cpu8',
                  '/sched_cpu0','/sched_cpu1','/sched_cpu2','/sched_cpu3',
                  '/sched_cpu4','/sched_cpu5','/sched_cpu6','/sched_cpu7',
                  '/sched_cpu8'],
      trackNames: [{name: 'RenderThread', tid: 4543}],
      pinTracks: ['/thread_75'],
      timeSpan: {start: '3428202643641', end: '3428410622726'},
      aspectRatio: 4 / 3,
      devicePixelRatio: 1, perTrackTimeoutMs: 20000,
    },
    uiRefClip: {x: 230, y: 114, width: 1690, height: 300},
  },
};

function sh(cmd) { execSync(cmd, {cwd: ROOT, stdio: 'pipe'}); }
function startEmptyDaemon() {
  try { sh('pkill -f "trace_processor_shell -D"'); } catch {}
  setTimeoutSync(1000);
  sh('nohup ./out/mac.release/trace_processor_shell -D > timeline-image-dev/results/native-tp.log 2>&1 &');
  setTimeoutSync(2000);
}
function setTimeoutSync(ms) { execSync(`sleep ${ms / 1000}`); }

async function main() {
  const scenarioName = process.argv[2];
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario ${scenarioName}. Frozen set: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  startEmptyDaemon();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = `${ROOT}timeline-image-dev/results/${ts}-golden-${scenarioName}`;
  mkdirSync(out, {recursive: true});
  const log = [];
  const t0 = Date.now();

  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
  page.on('console', (m) => log.push(m.text()));
  await page.goto('http://127.0.0.1:10000/?testing=1');
  const input = await page.waitForSelector('input.trace_file', {state: 'attached', timeout: 30000});
  await input.setInputFiles(scenario.trace ?? JANK_TRACE);
  await page.waitForFunction((markerUri) => {
    if (!(window.ctx && window.ctx.traceInfo)) return false;
    const walk = (n) => { if (n.uri === markerUri) return true; for (const c of n.children) if (walk(c)) return true; return false; };
    return walk(window.ctx.defaultWorkspace.tracks);
  }, scenario.workspaceMarker ?? '/thread_7303', {timeout: 120000});
  log.push(`workspace ready at ${Date.now() - t0}ms`);
  // Safety net: dismiss any modal (should not appear with an empty daemon).
  const modalCount = await page.evaluate(() => {
    const modals = document.querySelectorAll('.pf-modal-backdrop');
    modals.forEach((m) => m.remove());
    return modals.length;
  });
  log.push(`modals dismissed: ${modalCount}`);
  await page.waitForTimeout(1500);

  // UI reference BEFORE offscreen render (same default view).
  const uiPng = await page.screenshot({clip: scenario.uiRefClip});
  writeFileSync(`${out}/ui-reference.png`, uiPng);

  const evalOpts = {...scenario.opts};
  const result = await page.evaluate(async (opts) => {
    const r = await window.ctx.timelineImage.renderTimelineImage(opts);
    const ab = await r.blob.arrayBuffer();
    const u8 = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return {b64: btoa(bin), width: r.width, height: r.height, warnings: r.warnings,
      perf: r.perf, tracks: r.trackBoxes.map((b) => ({name: b.name, uri: b.uri, h: b.height, depth: b.depth, group: b.isGroupHeader || false}))};
  }, evalOpts);
  writeFileSync(`${out}/golden.png`, Buffer.from(result.b64, 'base64'));
  const engine = log.find((l) => l.includes('Opening trace using native accelerator')) ? 'native' : 'wasm';
  writeFileSync(`${out}/engine.txt`, engine);
  writeFileSync(`${out}/metadata.json`, JSON.stringify({
    scenario: scenarioName, description: scenario.description, opts: scenario.opts,
    width: result.width, height: result.height, warnings: result.warnings,
    perf: result.perf, trackCount: result.tracks.length, tracks: result.tracks,
  }, null, 1));
  writeFileSync(`${out}/run.json`, JSON.stringify({
    scenario: scenarioName, startedAt: ts, wallMs: Date.now() - t0, engine,
    trace: (scenario.trace ?? JANK_TRACE).split('/').pop(), modalsDismissed: modalCount,
  }, null, 1));
  writeFileSync(`${out}/run.log`, log.join('\n'));
  // ---- baseline discipline (plan v9.13): expectations are frozen files.
  // A change of implementation must NOT silently change expectations;
  // updating a baseline is an explicit, reviewable act.
  const baselinePath = `${ROOT}tools/timeline-image/baselines/${scenarioName}.json`;
  const fingerprint = (r) => JSON.stringify({
    width: r.width, height: r.height, warnings: r.warnings,
    tracks: r.tracks.map((t) => [t.name, t.uri, t.h, t.depth, t.group]),
  });
  let pngHash = 0x811c9dc5;
  for (const b of Buffer.from(result.b64, 'base64')) pngHash = ((pngHash ^ b) * 0x01000193) >>> 0;
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(baselinePath, JSON.stringify({
      scenario: scenarioName, fingerprint: fingerprint(result), pngHash: pngHash.toString(16),
      note: 'sequence and pngHash are both hard expectations (byte determinism proven 20/20 on GPU and SwiftShader, T1.14 closed)',
    }, null, 1));
    console.log('BASELINE UPDATED: ' + baselinePath);
  } else {
    let baseline;
    try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch (e) { console.log('BASELINE READ ERROR:', String(e)); baseline = undefined; }
    if (!baseline) {
      console.log('BASELINE MISSING — run with --update-baseline to freeze expectations first');
      process.exitCode = 2;
    } else if (baseline.fingerprint !== fingerprint(result)) {
      console.log('BASELINE MISMATCH (track sequence/size/warnings changed).');
      console.log('  If intentional: update the baseline in a separate, explained commit.');
      console.log('  Diff: ' + baselinePath);
      process.exitCode = 1;
    } else if (baseline.pngHash !== pngHash.toString(16)) {
      // Hard assertion since T1.14 closed: renders are byte-deterministic
      // (verified 20/20 on both GPU and SwiftShader backends).
      console.log('BASELINE PIXEL MISMATCH (hard failure).');
      process.exitCode = 1;
    } else {
      console.log('BASELINE MATCH ✓');
      // Refresh LATEST pointers to this verified run (T1.13).
      for (const [link, target] of [
        [`${ROOT}timeline-image-dev/results/LATEST-png`, `${out}/golden.png`],
        [`${ROOT}timeline-image-dev/results/LATEST-${scenarioName}.json`, `${out}/metadata.json`],
      ]) {
        rmSync(link, {force: true});
        symlinkSync(target, link);
      }
    }
  }
  console.log(`${scenarioName}: ${result.width}x${result.height}, tracks=${result.tracks.length}, warnings=${JSON.stringify(result.warnings)}, engine=${engine}, wall=${Date.now() - t0}ms`);
  console.log(`artifacts: ${out}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
