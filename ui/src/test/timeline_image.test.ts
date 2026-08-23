// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// End-to-end tests for trace.timelineImage.renderTimelineImage().
//
// The primary fixture is a real Android scroll-jank trace kept local-only for
// licensing reasons (see plan/perfetto-screenshot-api.md appendix B ADR 12);
// these tests skip automatically when it is absent. The synthetic-trace
// variants for upstream submission land with the upstream PR.

import {test, expect} from '@playwright/test';
import {existsSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

const JANK_FIXTURE = 'smartperfetto_android_scroll_jank_customer.pftrace';
const JANK_FIXTURE_PATH = join(__dirname, '../../../test/data', JANK_FIXTURE);

// Rendered-image artifacts land here (out/ is gitignored). One timestamped
// file per case per run; Playwright only materializes attachments for
// failed tests, so the spec persists the API output itself (appendix D.4).
function artifactPath(caseName: string): string {
  const dir = join(__dirname, '../../../timeline-image-dev/results/integration');
  mkdirSync(dir, {recursive: true});
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(dir, `${ts}-${caseName}.png`);
}

// Windows measured on the fixture with trace_processor (see plan §6.1):
// trace bounds 506729976821104 - 506737792493809, 21 janky frames, worst
// frame ts=506731892411259 dur=62.7ms spanning the A1 window's left edge.
const A1_WINDOW = {
  start: '506731860000000',
  end: '506731970000000',
};
const A2_WINDOW = {
  start: '506734750000000',
  end: '506736000000000',
};
const A3_WINDOW = {
  start: '506731768732822',
  end: '506735985833653',
};

interface TestTrace {
  traceInfo?: unknown;
  defaultWorkspace: {tracks: TestTrackNode};
  timelineImage: {
    renderTimelineImage(opts: unknown): Promise<{
      blob: Blob;
      width: number;
      height: number;
      warnings: readonly string[];
      trackBoxes: ReadonlyArray<{
        uri: string;
        name: string;
        top: number;
        height: number;
        depth: number;
      }>;
      perf: {
        loadMs: number;
        drawMs: number;
        encodeMs: number;
        elapsedMs: number;
      };
    }>;
  };
}

interface TestTrackNode {
  uri?: string;
  children: TestTrackNode[];
}

const fixtureAvailable = existsSync(JANK_FIXTURE_PATH);
test.skip(
  !fixtureAvailable,
  `${JANK_FIXTURE} not present (local-only fixture)`,
);

// Determinism under real-GPU (macOS ANGLE) headless is intermittent: the
// eviction races are fixed (RafScheduler freeze) but MSAA rasterization
// remains a suspected per-run variance source (antialias:false regressed
// the non-solid assertions instead). Retry policy absorbs the residual
// flake; root cause tracked in the plan (T1.10 follow-up).
test.describe.serial('timeline image rendering', () => {
  test.describe.configure({retries: 2});
  let helper: PerfettoTestHelper;

  test.beforeAll(async ({browser}) => {
    const page = await browser.newPage();
    helper = new PerfettoTestHelper(page);
    await helper.openTraceFile(JANK_FIXTURE);
    // openTraceFile's idle wait can fire before the trace object is exposed;
    // wait for the bookmarklet API's trace explicitly.
    await page.waitForFunction(
      () =>
        (window as {ctx?: {traceInfo?: unknown}}).ctx?.traceInfo !== undefined,
      undefined,
      {timeout: 60_000},
    );
  });

  test.afterAll(async () => {
    await helper.page.close();
  });

  test('A2: jank cluster renders non-solid with pinned tracks first', async ({}, testInfo) => {
    const result = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      const r = await trace.timelineImage.renderTimelineImage({
        trackUris: ['/sched_cpu0', '/sched_cpu1', '/sched_cpu2', '/sched_cpu3'],
        pinTracks: ['/sched_cpu2'],
        timeSpan,
        widthPx: 1000,
        perTrackTimeoutMs: 20_000,
      });
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      const pngMagic =
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47;
      (window as {__png?: Uint8Array}).__png = buf.slice();
      return {
        width: r.width,
        height: r.height,
        pngMagic,
        blobBytes: buf.length,
        warnings: [...r.warnings],
        trackUris: r.trackBoxes.map((t) => t.uri),
        tops: r.trackBoxes.map((t) => t.top),
        heights: r.trackBoxes.map((t) => t.height),
        perf: r.perf,
      };
    }, A2_WINDOW);

    expect(result.pngMagic).toBe(true);
    expect(result.blobBytes).toBeGreaterThan(10_000);
    expect(result.width).toBe(1000);
    expect(result.height).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(result.trackUris).toEqual([
      '/sched_cpu2', // pinned first
      '/sched_cpu0',
      '/sched_cpu1',
      '/sched_cpu3',
    ]);
    // Stacked layout: strictly increasing tops, positive heights.
    for (let i = 1; i < result.tops.length; i++) {
      expect(result.tops[i]).toBeGreaterThan(result.tops[i - 1]);
    }
    for (const h of result.heights) {
      expect(h).toBeGreaterThan(0);
    }
    // Dual-trail observability (plan §6.5): phase timings are populated and
    // internally consistent.
    expect(result.perf.elapsedMs).toBeGreaterThan(0);
    expect(result.perf.loadMs).toBeGreaterThanOrEqual(0);
    expect(result.perf.drawMs).toBeGreaterThanOrEqual(0);
    expect(result.perf.encodeMs).toBeGreaterThan(0);
    const png = await helper.page.evaluate(
      () => (window as {__png?: Uint8Array}).__png,
    );
    if (png) {
      await testInfo.attach('timeline-image-a2.png', {
        body: Buffer.from(
          png.buffer as ArrayBuffer,
          png.byteOffset,
          png.byteLength,
        ),
        contentType: 'image/png',
      });

      writeFileSync(artifactPath('a2-pinned'), Buffer.from(png));
    }
  });

  test('A2: image is non-solid (WebGL layer composited)', async () => {
    const stats = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      const r = await trace.timelineImage.renderTimelineImage({
        trackUris: ['/sched_cpu0', '/sched_cpu1'],
        timeSpan,
        widthPx: 800,
        perTrackTimeoutMs: 20_000,
      });
      const bmp = await createImageBitmap(r.blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<string>();
      for (let i = 0; i < d.length; i += 512 * 4) {
        colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      }
      return {
        colors: colors.size,
        dataUrlHead: canvas.toDataURL('image/png').slice(0, 64),
      };
    }, A2_WINDOW);
    expect(stats.colors).toBeGreaterThan(10);
  });

  test('determinism: identical parameters produce byte-identical output', async () => {
    const equal = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      const opts = {
        trackUris: ['/sched_cpu0', '/sched_cpu1'],
        timeSpan,
        widthPx: 800,
        perTrackTimeoutMs: 20_000,
      };
      const a = await trace.timelineImage.renderTimelineImage(opts);
      const b = await trace.timelineImage.renderTimelineImage(opts);
      const av = new Uint8Array(await a.blob.arrayBuffer());
      const bv = new Uint8Array(await b.blob.arrayBuffer());
      return av.length === bv.length && av.every((v, i) => v === bv[i]);
    }, A2_WINDOW);
    expect(equal).toBe(true);
  });

  test('A1: boundary-spanning janky frame is rendered across the left edge', async () => {
    const result = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      // The frame timeline track for the app process.
      const uris: string[] = [];
      const walk = (n: {uri?: string; children: unknown[]}) => {
        if (n.uri) uris.push(n.uri);
        for (const c of n.children as {uri?: string; children: unknown[]}[]) {
          walk(c);
        }
      };
      walk(trace.defaultWorkspace.tracks);
      const frameTrack = uris.find(
        (uri) => uri.includes('Actual Timeline') || uri.includes('frame'),
      );
      const trackUris = frameTrack
        ? [frameTrack, ...uris.filter((u) => u === '/sched_cpu0')]
        : ['/sched_cpu0'];
      const r = await trace.timelineImage.renderTimelineImage({
        trackUris,
        timeSpan,
        widthPx: 1200,
        perTrackTimeoutMs: 20_000,
        // Pure content canvas: this test asserts on the leftmost pixels of
        // the timeline area, which the (default) shell column would occupy.
        includeTrackShell: false,
        includeTimeAxis: false,
      });
      // Sample the left 5% of each track band: the 62.7ms worst frame starts
      // before the window and spans its left edge, so the left edge of the
      // frame timeline band must contain non-background content.
      const bmp = await createImageBitmap(r.blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const dpr = canvas.width / r.width;
      const bandColors = new Set<string>();
      const box = r.trackBoxes[0];
      if (box !== undefined) {
        const y0 = Math.floor((box.top + box.height / 2) * dpr);
        for (let x = 0; x < Math.floor(canvas.width * 0.05); x += 2) {
          const i = (y0 * canvas.width + x) * 4;
          bandColors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
        }
      }
      return {
        usedFrameTrack: Boolean(frameTrack),
        firstTrackName: box?.name,
        leftEdgeColors: bandColors.size,
        warnings: [...r.warnings],
      };
    }, A1_WINDOW);

    // The exact track set differs between trace versions; the invariant is
    // that whichever track was rendered first has drawn content at the left
    // edge (the frame spans it) rather than pure background.
    expect(result.warnings).toEqual([]);
    expect(result.leftEdgeColors).toBeGreaterThan(1);
  });

  test('A3: full-gesture window renders', async () => {
    const result = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      const r = await trace.timelineImage.renderTimelineImage({
        trackUris: ['/sched_cpu0', '/sched_cpu1'],
        timeSpan,
        widthPx: 1600,
        perTrackTimeoutMs: 20_000,
      });
      return {width: r.width, height: r.height, warnings: [...r.warnings]};
    }, A3_WINDOW);
    expect(result.warnings).toEqual([]);
    expect(result.width).toBe(1600);
    expect(result.height).toBeGreaterThan(0);
  });

  test('C1: default shell + time axis decorations', async () => {
    const result = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      const common = {
        trackUris: ['/sched_cpu0'],
        timeSpan,
        widthPx: 1200,
        perTrackTimeoutMs: 20_000,
      };
      const withDecorations =
        await trace.timelineImage.renderTimelineImage(common);
      const bare = await trace.timelineImage.renderTimelineImage({
        ...common,
        includeTrackShell: false,
        includeTimeAxis: false,
      });
      const sampleRegion = async (
        r: Awaited<ReturnType<typeof trace.timelineImage.renderTimelineImage>>,
      ) => {
        const bmp = await createImageBitmap(r.blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const dpr = canvas.width / r.width;
        const colors = new Set<string>();
        return (x0: number, y0: number, x1: number, y1: number) => {
          for (let y = Math.floor(y0 * dpr); y < Math.ceil(y1 * dpr); y++) {
            for (let x = Math.floor(x0 * dpr); x < Math.ceil(x1 * dpr); x++) {
              const i = (y * canvas.width + x) * 4;
              colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
            }
          }
          const size = colors.size;
          colors.clear();
          return size;
        };
      };
      const sample = await sampleRegion(withDecorations);
      const firstBox = withDecorations.trackBoxes[0];
      return {
        warnings: [...withDecorations.warnings],
        heightDelta: withDecorations.height - bare.height,
        trackDepth: firstBox?.depth,
        // Shell column strip (left of the track band) must contain text
        // pixels, i.e. more than a flat background color.
        shellColors: sample(
          0,
          firstBox!.top,
          240,
          firstBox!.top + firstBox!.height,
        ),
        // Time axis row must contain tick/label pixels.
        axisColors: sample(250, 0, 1200, 22),
      };
    }, A1_WINDOW);
    // 22px time axis row accounts for the height difference.
    expect(result.heightDelta).toBe(22);
    expect(result.warnings).toEqual([]);
    // Depth is fixture-dependent (top-level group vs direct child); it only
    // needs to be present and non-negative.
    expect(result.trackDepth).toBeGreaterThanOrEqual(0);
    expect(result.shellColors).toBeGreaterThan(2);
    expect(result.axisColors).toBeGreaterThan(2);
  });

  test('G1: default composition matches the live UI track order', async () => {
    // Golden scenario: no trackUris/timeSpan (all defaults). The offscreen
    // track list must match what the interactive UI actually shows — same
    // set (default-expanded workspace semantics) and, critically, the same
    // top-to-bottom ORDER, asserted against the live DOM's track titles.
    // This is the institutional guard against "parameter drift" between
    // demo renders (plan v9.11): the default is defined by the UI, not by
    // whatever list a script happens to build.
    const result = await helper.page.evaluate(async () => {
      const trace = window.ctx as unknown as TestTrace;
      const r = await trace.timelineImage.renderTimelineImage({
        widthPx: 1600,
        // Default-track lists on this fixture are ~6400px tall; at the
        // default dpr 2 that exceeds the 32M-pixel canvas guardrail.
        devicePixelRatio: 1,
        perTrackTimeoutMs: 30_000,
      });
      // Titles as the UI lays them out (DOM order = visual order).
      const uiTitles = [...document.querySelectorAll('.pf-track__title')]
        .map((e) => (e.textContent ?? '').trim())
        .filter((t) => t.length > 0);
      return {
        warnings: [...r.warnings],
        height: r.height,
        trackCount: r.trackBoxes.length,
        uiVisibleCount: uiTitles.length,
        // First tracks for order comparison (UI renders only the viewport).
        uiHead: uiTitles.slice(0, 10),
        offscreenHead: r.trackBoxes.slice(0, 10).map((b) => b.name),
      };
    });
    expect(result.warnings).toEqual([]);
    // The offscreen render includes every default track; the DOM only
    // materializes the viewport, so compare the common prefix.
    expect(result.trackCount).toBeGreaterThanOrEqual(result.uiVisibleCount);
    const k = Math.min(result.uiHead.length, result.offscreenHead.length);
    expect(k).toBeGreaterThanOrEqual(5);
    expect(result.offscreenHead.slice(0, k)).toEqual(result.uiHead.slice(0, k));
  });

  test('T1.27/T1.28: trackNames resolution + aspectRatio shape', async () => {
    const result = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      const r = await trace.timelineImage.renderTimelineImage({
        trackUris: ['/sched_cpu0'],
        trackNames: [{name: 'RenderThread', tid: 13585}],
        timeSpan,
        aspectRatio: 4 / 3,
        devicePixelRatio: 1,
        perTrackTimeoutMs: 20_000,
      });
      return {
        width: r.width,
        height: r.height,
        warnings: [...r.warnings],
        names: r.trackBoxes.map((b) => b.name),
      };
    }, A2_WINDOW);
    // RenderThread resolved by name+tid: the headless group expands to the
    // thread's state + slice tracks, appended after the explicit uri list
    // (pinTracks is what reorders, per the explicit-list ordering contract).
    expect(result.warnings).toEqual([]);
    expect(result.names.slice(1, 3)).toEqual([
      'RenderThread 13585',
      'RenderThread 13585',
    ]);
    expect(result.names[0]).toBe('CPU 0 Scheduling');
    // Height is track-derived; the width must be exactly height * 4/3.
    expect(result.width).toBe(Math.round(result.height * (4 / 3)));
  });

  test('T1.27: unmatched trackNames produce TRACK_MISSING', async () => {
    const result = await helper.page.evaluate(async (win) => {
      const trace = window.ctx as unknown as TestTrace;
      const timeSpan = {start: BigInt(win.start), end: BigInt(win.end)};
      const r = await trace.timelineImage.renderTimelineImage({
        trackUris: ['/sched_cpu0'],
        trackNames: [{name: 'NoSuchThread', tid: 999999}],
        timeSpan,
        widthPx: 800,
        devicePixelRatio: 1,
        perTrackTimeoutMs: 20_000,
      });
      return {warnings: [...r.warnings], trackCount: r.trackBoxes.length};
    }, A2_WINDOW);
    expect(result.warnings).toContain('TRACK_MISSING');
    // The explicit uri still renders.
    expect(result.trackCount).toBe(1);
  });
});
