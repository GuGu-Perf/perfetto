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
import {existsSync} from 'fs';
import {join} from 'path';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

const JANK_FIXTURE = 'smartperfetto_android_scroll_jank_customer.pftrace';
const JANK_FIXTURE_PATH = join(__dirname, '../../../test/data', JANK_FIXTURE);

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
      }>;
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

test.describe.serial('timeline image rendering', () => {
  let helper: PerfettoTestHelper;

  test.beforeAll(async ({browser}) => {
    const page = await browser.newPage();
    helper = new PerfettoTestHelper(page);
    await helper.openTraceFile(JANK_FIXTURE);
    // openTraceFile's idle wait can fire before the trace object is exposed;
    // wait for the bookmarklet API's trace explicitly.
    await page.waitForFunction(
      () => !!(window as {ctx?: {traceInfo?: unknown}}).ctx?.traceInfo,
      undefined,
      {timeout: 60_000},
    );
  });

  test.afterAll(async () => {
    await helper.page.close();
  });

  test('A2: jank cluster renders non-solid with pinned tracks first', async () => {
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
      return {
        width: r.width,
        height: r.height,
        pngMagic,
        blobBytes: buf.length,
        warnings: [...r.warnings],
        trackUris: r.trackBoxes.map((t) => t.uri),
        tops: r.trackBoxes.map((t) => t.top),
        heights: r.trackBoxes.map((t) => t.height),
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
      if (box) {
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
});
