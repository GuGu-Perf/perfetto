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

/**
 * Offscreen timeline renderer: renders an ordered list of tracks for a time
 * span onto a fresh canvas, without involving the interactive timeline's DOM
 * or rAF scheduling.
 *
 * The render is two-phased:
 *  1. Warm-up: for every track, await `whenDataReady()` with the exact render
 *     context that the draw phase will use, so the data loaded is guaranteed
 *     to match what is drawn (identical AsyncMemo keys).
 *  2. Draw: synchronously draw all tracks via the shared
 *     `renderTimelineCanvas()` sequence, then re-check readiness to catch
 *     data-dependent second-order queries (fixed point, bounded rounds).
 *
 * Session-bound visuals (hover markers, notes, selection, overlays, flows)
 * are not drawn, producing deterministic output.
 *
 * Data resolution is decoupled from the canvas resolution by default: data is
 * fetched at `dataResolutionScale` (0.5) of the canvas resolution, i.e. 1x
 * data on a 2x (dpr) canvas.
 */

import {Rect2D} from '../../base/geom';
import type {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import {calculateResolution} from '../../base/resolution';
import {TimeScale} from '../../base/time_scale';
import type {duration} from '../../base/time';
import type {TrackRenderContext} from '../../public/track';
import {TrackNode} from '../../public/workspace';
import type {TraceImpl} from '../../core/trace_impl';
import {Canvas2DRenderer} from '../../base/canvas2d_renderer';
import {WebGLRenderer} from '../../base/gl/webgl_renderer';
import type {Renderer} from '../../base/renderer';
import {COLOR_BACKGROUND} from '../../frontend/css_constants';
import {traceEvent} from '../../core/metatracing';
import {TrackView} from './track_view';
import {
  getDefaultCanvasColors,
  renderTimelineCanvas,
} from './timeline_canvas_renderer';

// Guard rails for the output canvas. Browsers cap canvas edge lengths
// (~16384) and total area; staying within 32M pixels keeps the backing store
// around 128MB of RGBA.
const MAX_CANVAS_EDGE_PX = 16384;
const MAX_CANVAS_AREA_PX = 32_000_000;

// Warm-up budget for fixed-point rounds after the first: later rounds only
// wait for second-order queries, so a small cap keeps the worst case within
// the "one minute per image" service budget (plan §1.4).
const SECOND_ROUND_BUDGET_MS = 5_000;

export interface OffscreenTimelineRenderOptions {
  readonly trace: TraceImpl;
  // Ordered list of track URIs to render, top to bottom.
  readonly trackUris: readonly string[];
  readonly timeSpan: HighPrecisionTimeSpan;
  // Width of the produced image in CSS pixels.
  readonly widthPx: number;
  // Device pixel ratio of the produced canvas. Default: 2.
  readonly devicePixelRatio?: number;
  // Data is fetched at this fraction of the canvas resolution (power-of-two
  // quantization preserved). Default: 0.5 (1x data on a 2x canvas).
  readonly dataResolutionScale?: number;
  // Per-track warm-up budget in ms before the track is drawn as-is (possibly
  // with loading placeholders) and reported in `timedOutTracks`.
  // Default: 5000.
  readonly perTrackTimeoutMs?: number;
  // Maximum number of warm-up/draw rounds (fixed point for data-dependent
  // second-order queries). Default: 3.
  readonly maxRounds?: number;
}

export interface OffscreenTimelineRenderOutput {
  // The composited image: background + WebGL layer + Canvas 2D layer.
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  // Bounding boxes of the rendered tracks, in CSS pixels relative to the
  // top-left of the canvas.
  readonly trackBoxes: ReadonlyArray<{
    uri: string;
    name: string;
    top: number;
    height: number;
  }>;
  // Tracks whose data did not become ready within the per-track budget.
  readonly timedOutTracks: readonly string[];
  // Number of fixed-point rounds actually executed.
  readonly rounds: number;
  // Phase timings (ms), mirroring the metatrace event names (plan §6.5).
  readonly perf: {loadMs: number; drawMs: number};
}

export async function renderOffscreenTimeline(
  options: OffscreenTimelineRenderOptions,
): Promise<OffscreenTimelineRenderOutput> {
  const {
    trace,
    trackUris,
    timeSpan,
    widthPx,
    devicePixelRatio = 2,
    dataResolutionScale = 0.5,
    perTrackTimeoutMs = 5_000,
    maxRounds = 3,
  } = options;

  // ------------------------------------------------------------------ layout
  const trackViews: TrackView[] = [];
  const trackBoxes: {uri: string; name: string; top: number; height: number}[] =
    [];
  const missingTracks: string[] = [];
  let top = 0;
  for (const uri of trackUris) {
    // Headless nodes are grouping containers (e.g. a thread node holding its
    // slice & state tracks); expand them so the requested tracks actually
    // render instead of collapsing to zero height.
    const nodes = resolveRenderableTrackNodes(trace, uri);
    if (nodes.length === 0) {
      missingTracks.push(uri);
      continue;
    }
    for (const node of nodes) {
      const view = new TrackView(trace, node, top, false);
      trackViews.push(view);
      trackBoxes.push({
        uri: node.uri ?? uri,
        name: node.name,
        top,
        height: view.height,
      });
      top += view.height;
    }
  }
  if (trackViews.length === 0) {
    throw new Error(
      `renderOffscreenTimeline: no renderable tracks ` +
        `(missing: ${missingTracks.join(', ')})`,
    );
  }

  if (!(widthPx >= 1)) {
    throw new Error('renderOffscreenTimeline: widthPx must be >= 1');
  }

  const cssWidth = widthPx;
  const cssHeight = top;
  const pixels = cssWidth * devicePixelRatio * cssHeight * devicePixelRatio;
  if (
    cssWidth * devicePixelRatio > MAX_CANVAS_EDGE_PX ||
    cssHeight * devicePixelRatio > MAX_CANVAS_EDGE_PX ||
    pixels > MAX_CANVAS_AREA_PX
  ) {
    throw new Error(
      `renderOffscreenTimeline: output canvas too large ` +
        `(${cssWidth}x${cssHeight} @${devicePixelRatio}x)`,
    );
  }

  // Data resolution: like the interactive path, quantized to a power of two,
  // but computed for `widthPx / dataResolutionScale` so that (with the
  // default 0.5) a 2x canvas fetches 1x data.
  const maybeResolution = calculateResolution(
    timeSpan,
    Math.max(1, widthPx / dataResolutionScale),
  );
  if (!maybeResolution.ok) {
    throw new Error(
      `renderOffscreenTimeline: cannot compute resolution: ` +
        `${maybeResolution.error}`,
    );
  }
  const resolution: duration = maybeResolution.value;

  // ------------------------------------------------------------ canvases
  // Layer model mirrors the interactive timeline: a WebGL canvas below and a
  // Canvas 2D canvas above; here both are composited onto one opaque canvas.
  // The surfaces (and the WebGL context) are shared across renders: browsers
  // cap live GL contexts per page (~16), so creating one per render would
  // exhaust them quickly. The context is recreated periodically to avoid
  // unbounded state accumulation (see MAX_RENDERS_PER_CONTEXT).
  const {d2Canvas, d2Ctx, glCanvas, glCtx, renderer} = acquireSharedSurfaces(
    cssWidth,
    cssHeight,
    devicePixelRatio,
  );

  const colors = getDefaultCanvasColors();
  const timelineRect = new Rect2D({
    left: 0,
    top: 0,
    right: cssWidth,
    bottom: cssHeight,
  });
  const timescale = new TimeScale(timeSpan, timelineRect);

  const timedOutTracks: string[] = [];
  const renderContexts = new Map<TrackView, TrackRenderContext>();
  for (const view of trackViews) {
    const trackRect = new Rect2D({
      left: 0,
      top: view.verticalBounds.top,
      right: cssWidth,
      bottom: view.verticalBounds.bottom,
    });
    renderContexts.set(view, {
      trackUri: view.node.uri ?? '',
      trackNode: view.node,
      visibleWindow: timeSpan,
      size: trackRect,
      resolution,
      queryBounds: timeSpan.toTimeSpan(),
      ctx: d2Ctx,
      timescale: new TimeScale(timeSpan, {left: 0, right: cssWidth}),
      colors,
      renderer,
    });
  }

  const warmUp = async (budgetMs: number) => {
    // Wait for all tracks concurrently: total wall-clock is bounded by the
    // per-track budget, not by the sum over tracks. The underlying
    // AtomicTaskQueue still executes queries one at a time.
    const settledPerTrack = await Promise.all(
      trackViews.map(async (view) => {
        const renderCtx = renderContexts.get(view);
        const trackRenderer = view.renderer?.track;
        if (!renderCtx || !view.node.uri || !trackRenderer?.whenDataReady) {
          return true;
        }
        const settled = await withTimeout(
          trackRenderer.whenDataReady(renderCtx),
          budgetMs,
        );
        if (!settled && !timedOutTracks.includes(view.node.uri)) {
          timedOutTracks.push(view.node.uri);
        }
        return settled;
      }),
    );
    return settledPerTrack.every((settled) => settled);
  };

  // Warm-up/draw fixed point. Two termination hazards are handled by
  // demanding a STABLE frame: (a) drawing can trigger data-dependent
  // second-order queries; (b) the interactive timeline's rAF redraws can
  // evict our memo entries across an await boundary, leaving a drawn frame
  // based on stale/loading data (plan §3.3.3 phase B). A frame is considered
  // final only when a redraw produces a pixel-identical probe hash.
  // Freeze interactive canvas redraws for the whole warm-up/draw/composite
  // critical section: a live UI redraw between our await points evicts the
  // single-entry track memos and corrupts the frame (plan §3.3.3 phase B).
  trace.raf.freezeCanvasRedraws();
  let rounds = 0;
  let lastHash: string | undefined;
  let loadMs = 0;
  let drawMs = 0;
  try {
    for (;;) {
      const loadStart = performance.now();
      // Round 0 gets the full per-track budget; later rounds only wait for
      // data-dependent second-order queries to settle, which are cheap.
      const budget = rounds === 0 ? perTrackTimeoutMs : SECOND_ROUND_BUDGET_MS;
      await traceEvent(
        'TimelineImage.warmUp',
        () => warmUp(budget),
        {
          args: {round: String(rounds)},
        },
      );
      loadMs += performance.now() - loadStart;
      const drawStart = performance.now();
      traceEvent('TimelineImage.draw', () => draw(), {
        args: {round: String(rounds)},
      });
      drawMs += performance.now() - drawStart;
      rounds++;
      const hash = probeHash();
      if (hash === lastHash || rounds >= maxRounds) break;
      lastHash = hash;
    }
  } finally {
    trace.raf.thawCanvasRedraws();
  }

  // Cheap stability probe: downscale both layers into a tiny canvas and
  // hash the pixels. Two consecutive identical hashes mean no memo eviction
  // or second-order query altered the output between rounds.
  function probeHash(): string {
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 32;
    const pctx = ensure2d(probe);
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, 32, 32);
    if (glCanvas) {
      pctx.drawImage(
        glCanvas,
        0,
        0,
        glCanvas.width,
        glCanvas.height,
        0,
        0,
        32,
        32,
      );
    }
    pctx.drawImage(
      d2Canvas,
      0,
      0,
      d2Canvas.width,
      d2Canvas.height,
      0,
      0,
      32,
      32,
    );
    const d = pctx.getImageData(0, 0, 32, 32).data;
    let h = '';
    for (let i = 0; i < d.length; i += 4) {
      h += String.fromCharCode(d[i] & 0xff, d[i + 1] & 0xff, d[i + 2] & 0xff);
    }
    return h;
  }

  function draw() {
    renderer.resetTransform();
    renderer.clear();
    using _transform = renderer.pushTransform({
      scaleX: devicePixelRatio,
      scaleY: devicePixelRatio,
    });
    renderTimelineCanvas({
      ctx: d2Ctx,
      size: {width: cssWidth, height: cssHeight},
      timelineRect,
      timescale,
      visibleWindow: timeSpan,
      renderedTracks: trackViews,
      // No virtual scrolling offscreen: everything overlaps the full rect.
      floatingCanvasRect: timelineRect,
      rootNode: new TrackNode(),
      trace,
      colors,
      renderer,
      tickOrigin: trace.timeline.getTimeAxisOrigin(),
      perfStatsEnabled: false,
      trackPerfStats: new WeakMap(),
      resolutionOverride: resolution,
      includeGrid: true,
      includeSessionOverlays: false,
    });
    if (glCtx) {
      glCtx.flush();
    }
  }

  // -------------------------------------------------------------- composite
  traceEvent('TimelineImage.e2e', () => {}, {args: {rounds: String(rounds)}});
  const outCanvas = createCanvas(cssWidth, cssHeight, devicePixelRatio);
  const outCtx = ensure2d(outCanvas);
  outCtx.fillStyle = COLOR_BACKGROUND;
  outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  if (glCtx && glCanvas) {
    // WebGL layer below, Canvas 2D layer (text etc.) above, matching the
    // interactive z-order. Composite via createImageBitmap rather than a
    // direct drawImage: after a canvas resize the 2D drawImage path can
    // serve a stale snapshot of the GL buffer (first readback only), while
    // the bitmap path performs a fresh readback (plan T1.10 for root cause).
    const glBitmap = await createImageBitmap(glCanvas);
    outCtx.drawImage(glBitmap, 0, 0);
    glBitmap.close();
  }
  outCtx.drawImage(d2Canvas, 0, 0);

  return {
    canvas: outCanvas,
    width: cssWidth,
    height: cssHeight,
    trackBoxes,
    timedOutTracks,
    rounds,
    perf: {loadMs, drawMs},
  };
}

function resolveTrackNode(
  trace: TraceImpl,
  uri: string,
): TrackNode | undefined {
  // Prefer the real workspace node (keeps name & metadata); fall back to a
  // bare node so rendering works even for unlisted URIs.
  const existing = findNodeByUri(trace.defaultWorkspace.tracks, uri);
  if (existing) return existing;
  if (trace.tracks.getTrack(uri)) {
    return new TrackNode({uri, name: uri});
  }
  return undefined;
}

/**
 * Resolve a requested URI to the list of nodes that should actually be
 * rendered: headless grouping nodes are expanded to their renderable
 * (non-headless) descendants, in tree order.
 */
function resolveRenderableTrackNodes(
  trace: TraceImpl,
  uri: string,
): TrackNode[] {
  const node = resolveTrackNode(trace, uri);
  if (!node) return [];
  if (!node.headless) return [node];
  const descendants: TrackNode[] = [];
  const collect = (n: TrackNode) => {
    for (const child of n.children) {
      if (child.headless) {
        collect(child);
      } else {
        descendants.push(child);
      }
    }
  };
  collect(node);
  return descendants;
}

function findNodeByUri(node: TrackNode, uri: string): TrackNode | undefined {
  if (node.uri === uri) return node;
  for (const child of node.children) {
    const found = findNodeByUri(child, uri);
    if (found) return found;
  }
  return undefined;
}

interface SharedSurfaces {
  readonly d2Canvas: HTMLCanvasElement;
  readonly d2Ctx: CanvasRenderingContext2D;
  readonly glCanvas: HTMLCanvasElement;
  readonly glCtx: WebGL2RenderingContext;
  readonly renderer: WebGLRenderer;
  renders: number;
  lastWidth: number;
  lastHeight: number;
}

// Recreate the shared WebGL context after this many renders to avoid state
// accumulation in long-lived rendering processes.
const MAX_RENDERS_PER_CONTEXT = 200;

let sharedSurfaces: SharedSurfaces | undefined;
let contextsCreated = 0;

export function getOffscreenSurfaceStats(): {
  renders: number;
  contextsCreated: number;
} {
  return {renders: sharedSurfaces?.renders ?? 0, contextsCreated};
}

export interface AcquiredSurfaces {
  surfaces?: SharedSurfaces;
  sizeChanged: boolean;
  d2Canvas: HTMLCanvasElement;
  d2Ctx: CanvasRenderingContext2D;
  glCanvas?: HTMLCanvasElement;
  glCtx?: WebGL2RenderingContext;
  renderer: Renderer;
}

function acquireSharedSurfaces(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): AcquiredSurfaces {
  if (
    sharedSurfaces &&
    (sharedSurfaces.renders >= MAX_RENDERS_PER_CONTEXT ||
      sharedSurfaces.lastWidth !== cssWidth ||
      sharedSurfaces.lastHeight !== cssHeight)
  ) {
    // Recreate on size change as well: a resized WebGL canvas can serve a
    // corrupted first frame from its back buffer (browser resize-transition
    // behaviour, see plan T1.10); a fresh context sidesteps the entire
    // class. Context churn is bounded by distinct sizes per session.
    disposeSharedSurfaces();
  }
  if (!sharedSurfaces) {
    const d2Canvas = document.createElement('canvas');
    const d2Ctx = ensure2d(d2Canvas);
    const glCanvas = document.createElement('canvas');
    const glCtx = glCanvas.getContext('webgl2', {
      alpha: true,
      // Keep the drawing buffer readable for the composite below; the
      // interactive timeline doesn't need this as the browser composites it.
      preserveDrawingBuffer: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!glCtx) {
      // WebGL unavailable: Canvas2DRenderer draws everything on the 2D layer.
      // No singleton needed in this mode.
      const canvas = resizeCanvas(d2Canvas, cssWidth, cssHeight, dpr);
      return {
        sizeChanged: true,
        d2Canvas: canvas,
        d2Ctx,
        renderer: new Canvas2DRenderer(d2Ctx),
      } satisfies AcquiredSurfaces;
    }
    sharedSurfaces = {
      d2Canvas,
      d2Ctx,
      glCanvas,
      glCtx,
      renderer: new WebGLRenderer(d2Ctx, glCtx),
      renders: 0,
      lastWidth: 0,
      lastHeight: 0,
    };
    contextsCreated++;
  }
  sharedSurfaces.renders++;
  const sizeChanged =
    sharedSurfaces.lastWidth !== cssWidth ||
    sharedSurfaces.lastHeight !== cssHeight;
  resizeCanvas(sharedSurfaces.d2Canvas, cssWidth, cssHeight, dpr);
  resizeCanvas(sharedSurfaces.glCanvas, cssWidth, cssHeight, dpr);
  sharedSurfaces.lastWidth = cssWidth;
  sharedSurfaces.lastHeight = cssHeight;
  return {
    surfaces: sharedSurfaces,
    sizeChanged,
    d2Canvas: sharedSurfaces.d2Canvas,
    d2Ctx: sharedSurfaces.d2Ctx,
    glCanvas: sharedSurfaces.glCanvas,
    glCtx: sharedSurfaces.glCtx,
    renderer: sharedSurfaces.renderer,
  };
}

function disposeSharedSurfaces(): void {
  if (!sharedSurfaces) return;
  try {
    sharedSurfaces.glCtx.getExtension('WEBGL_lose_context')?.loseContext();
  } finally {
    sharedSurfaces = undefined;
  }
}

function resizeCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): HTMLCanvasElement {
  canvas.width = Math.ceil(cssWidth * dpr);
  canvas.height = Math.ceil(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return canvas;
}

function createCanvas(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(cssWidth * dpr);
  canvas.height = Math.ceil(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return canvas;
}

function ensure2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('renderOffscreenTimeline: 2D context unavailable');
  }
  return ctx;
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
