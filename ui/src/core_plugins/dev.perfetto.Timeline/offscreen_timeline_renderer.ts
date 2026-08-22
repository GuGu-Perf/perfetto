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
    const node = resolveTrackNode(trace, uri);
    if (!node) {
      missingTracks.push(uri);
      continue;
    }
    const view = new TrackView(trace, node, top, false);
    trackViews.push(view);
    trackBoxes.push({
      uri,
      name: node.name,
      top,
      height: view.height,
    });
    top += view.height;
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

  const warmUp = async () => {
    let allSettledInstantly = true;
    for (const view of trackViews) {
      const renderCtx = renderContexts.get(view);
      const trackRenderer = view.renderer?.track;
      if (!renderCtx || !view.node.uri || !trackRenderer?.whenDataReady) {
        continue;
      }
      const ready = withTimeout(
        trackRenderer.whenDataReady(renderCtx),
        perTrackTimeoutMs,
      );
      const settled = await ready;
      if (!settled) {
        allSettledInstantly = false;
        if (!timedOutTracks.includes(view.node.uri)) {
          timedOutTracks.push(view.node.uri);
        }
      }
    }
    return allSettledInstantly;
  };

  // Warm-up/draw fixed point: drawing can trigger data-dependent second-order
  // queries; re-warm (bounded) until everything settles instantly.
  let rounds = 0;
  let allSettled = false;
  while (rounds < maxRounds && !(allSettled && rounds > 0)) {
    allSettled = await warmUp();
    draw();
    rounds++;
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
      includeGrid: true,
      includeSessionOverlays: false,
    });
    if (glCtx) {
      glCtx.flush();
    }
  }

  // -------------------------------------------------------------- composite
  const outCanvas = createCanvas(cssWidth, cssHeight, devicePixelRatio);
  const outCtx = ensure2d(outCanvas);
  outCtx.fillStyle = COLOR_BACKGROUND;
  outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  if (glCtx) {
    // WebGL layer below, Canvas 2D layer (text etc.) above, matching the
    // interactive z-order.
    outCtx.drawImage(glCanvas, 0, 0);
  }
  outCtx.drawImage(d2Canvas, 0, 0);

  return {
    canvas: outCanvas,
    width: cssWidth,
    height: cssHeight,
    trackBoxes,
    timedOutTracks,
    rounds,
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

function acquireSharedSurfaces(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
):
  | SharedSurfaces
  | {
      d2Canvas: HTMLCanvasElement;
      d2Ctx: CanvasRenderingContext2D;
      glCanvas?: undefined;
      glCtx?: undefined;
      renderer: Renderer;
    } {
  if (sharedSurfaces && sharedSurfaces.renders >= MAX_RENDERS_PER_CONTEXT) {
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
        d2Canvas: canvas,
        d2Ctx,
        renderer: new Canvas2DRenderer(d2Ctx),
      };
    }
    sharedSurfaces = {
      d2Canvas,
      d2Ctx,
      glCanvas,
      glCtx,
      renderer: new WebGLRenderer(d2Ctx, glCtx),
      renders: 0,
    };
    contextsCreated++;
  }
  sharedSurfaces.renders++;
  resizeCanvas(sharedSurfaces.d2Canvas, cssWidth, cssHeight, dpr);
  resizeCanvas(sharedSurfaces.glCanvas, cssWidth, cssHeight, dpr);
  return sharedSurfaces;
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
