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
import {Time, type duration} from '../../base/time';
import {formatDuration} from '../../components/time_utils';
import type {TrackRenderContext} from '../../public/track';
import {TrackNode} from '../../public/workspace';
import type {TraceImpl} from '../../core/trace_impl';
import {Canvas2DRenderer} from '../../base/canvas2d_renderer';
import {WebGLRenderer} from '../../base/gl/webgl_renderer';
import type {Renderer} from '../../base/renderer';
import {
  COLOR_BACKGROUND,
  COLOR_BORDER,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TRACK_SUMMARY_COLLAPSED,
  COLOR_TRACK_SUMMARY_EXPANDED,
  COLOR_TRACK_SUMMARY_EXPANDED_TEXT,
  FONT_COMPACT,
  TRACK_SHELL_WIDTH,
} from '../../frontend/css_constants';
import {traceEvent} from '../../core/metatracing';
import {TrackView} from './track_view';
import {generateTicks, getMaxMajorTicks, TickType} from './gridline_helper';
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

// Visual constants, mirroring the interactive timeline:
// - TimeAxisPanel.height is 22.
// - Track shell text and indentation come from track_shell.scss:
//   .pf-track { font: weight 300, size var(--pf-font-size-m) (14px),
//   font-family var(--pf-font-compact) }; grid indent column is
//   depth * var(--indent-size) (8px); the title sits 3px into the shell and
//   ellipsizes (text-overflow: ellipsis).
// Colors resolve through the css_constants runtime variables, so the output
// follows the page's active (light/dark) theme automatically.
const TIME_AXIS_HEIGHT_PX = 22;
const SHELL_INDENT_PX = 8;
const SHELL_TITLE_OFFSET_PX = 3;
const SHELL_FONT = `300 14px ${FONT_COMPACT}`;
const DEFAULT_WIDTH_PX = 1920;

export interface OffscreenTimelineRenderOptions {
  readonly trace: TraceImpl;
  // Ordered list of track URIs to render, top to bottom. Ignored when
  // `trackNodes` is provided.
  readonly trackUris: readonly string[];
  // Pre-resolved nodes in final order (adapter default collection): each
  // entry renders as-is, group headers included (18px summary rows, matching
  // the interactive tree). Takes precedence over `trackUris`.
  readonly trackNodes?: ReadonlyArray<{
    node: TrackNode;
    depth: number;
  }>;
  readonly timeSpan: HighPrecisionTimeSpan;
  // Width of the produced image in CSS pixels. Mutually exclusive with
  // `aspectRatio`; when neither is given the width defaults to 1920.
  readonly widthPx?: number;
  // Target width/height ratio; the width becomes round(height * ratio),
  // where the height derives from the track set. Mutually exclusive with
  // `widthPx`.
  readonly aspectRatio?: number;
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
  // Draw the track shell column (names, indentation) on the left, mirroring
  // the interactive timeline's track shell. Default: true.
  readonly includeTrackShell?: boolean;
  // Draw the time axis row (ticks + timecode labels, locale-independent)
  // above the tracks. Default: true.
  readonly includeTimeAxis?: boolean;
}

export interface OffscreenTimelineRenderOutput {
  // The composited image: background + WebGL layer + Canvas 2D layer.
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  // Bounding boxes of the rendered tracks, in CSS pixels relative to the
  // top-left of the canvas (i.e. including the time axis row when drawn).
  readonly trackBoxes: ReadonlyArray<{
    uri: string;
    name: string;
    top: number;
    height: number;
    // Nesting depth in the workspace tree, used for shell indentation.
    depth: number;
    // Group (summary/headless container) title rows render as 18px headers.
    readonly isGroupHeader: boolean;
    readonly expanded: boolean;
  }>;
  // Tracks whose data did not become ready within the per-track budget.
  readonly timedOutTracks: readonly string[];
  // Structured warning kinds (merged into the public result by the manager).
  readonly warnings: string[];
  // Effective device pixel ratio (after guardrail negotiation; may be lower
  // than requested on very tall compositions).
  readonly devicePixelRatio: number;
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
    aspectRatio,
    devicePixelRatio = 2,
    dataResolutionScale = 0.5,
    perTrackTimeoutMs = 5_000,
    // 8, not 3: data-dependent query chains occasionally need more than
    // three warm-up/draw rounds to converge; a premature cutoff leaves two
    // calls in different converged states (observed as a slice label
    // present in one output and absent in the other). The stability probe
    // still exits early once two rounds agree, so healthy renders stay at
    // 2-3 rounds; this ceiling only protects the fixed point.
    maxRounds = 8,
    includeTrackShell = true,
    includeTimeAxis = true,
    trackNodes,
  } = options;

  // Shape contract: widthPx and aspectRatio constrain the same degree of
  // freedom (the height is always derived from the track set), so at most
  // one may be given.
  if (widthPx !== undefined && aspectRatio !== undefined) {
    throw new Error(
      'renderOffscreenTimeline: widthPx and aspectRatio are mutually exclusive',
    );
  }
  if (aspectRatio !== undefined && !(aspectRatio > 0)) {
    throw new Error('renderOffscreenTimeline: aspectRatio must be > 0');
  }
  if (widthPx !== undefined && !(widthPx >= 1)) {
    throw new Error('renderOffscreenTimeline: widthPx must be >= 1');
  }

  // ------------------------------------------------------------------ layout
  const shellWidth = includeTrackShell ? TRACK_SHELL_WIDTH : 0;
  const axisHeight = includeTimeAxis ? TIME_AXIS_HEIGHT_PX : 0;
  const uriDepth = buildUriDepthMap(trace.defaultWorkspace.tracks);
  const trackViews: TrackView[] = [];
  const trackBoxes: {
    uri: string;
    name: string;
    top: number;
    height: number;
    depth: number;
    isGroupHeader: boolean;
    expanded: boolean;
  }[] = [];
  const missingTracks: string[] = [];
  // Track vertical bounds are canvas-absolute: they start below the time
  // axis row, as TrackView.drawCanvas places tracks at verticalBounds.top.
  let top = axisHeight;
  interface LayoutEntry {
    node: TrackNode;
    depth: number;
    uri: string;
    isGroupHeader: boolean;
    expanded: boolean;
  }
  const entries: LayoutEntry[] = [];
  if (trackNodes) {
    // Pre-resolved default collection: group header rows (summary or
    // headless containers) render as 18px title rows, exactly the rows the
    // interactive tree shows.
    for (const {node, depth} of trackNodes) {
      const isGroupHeader = node.isSummary || node.headless;
      entries.push({
        node,
        depth,
        uri: node.uri ?? '',
        isGroupHeader,
        expanded: node.expanded,
      });
    }
  } else {
    for (const uri of trackUris) {
      // Headless nodes are grouping containers (e.g. a thread node holding
      // its slice & state tracks); expand them so the requested tracks
      // actually render instead of collapsing to zero height.
      const nodes = resolveRenderableTrackNodes(trace, uri);
      if (nodes.length === 0) {
        missingTracks.push(uri);
        continue;
      }
      const requestDepth = uriDepth.get(uri) ?? 0;
      for (const node of nodes) {
        const nodeUri = node.uri ?? uri;
        entries.push({
          node,
          // Expanded descendants render one level deeper than the request.
          depth: uriDepth.get(nodeUri) ?? requestDepth + 1,
          uri: nodeUri,
          isGroupHeader: false,
          expanded: false,
        });
      }
    }
  }
  const seenUris = new Set<string>();
  for (const {node, depth, uri, isGroupHeader, expanded} of entries) {
    // A headless URI expands to its leaf tracks, which may also appear
    // verbatim in the list; render each track only once.
    if (uri !== '' && seenUris.has(uri)) continue;
    if (uri !== '') seenUris.add(uri);
    // showHeadless=true: group header rows (headless summary containers)
    // get their 18px title height instead of collapsing to zero.
    const view = new TrackView(trace, node, top, true);
    trackViews.push(view);
    trackBoxes.push({
      uri,
      name: node.name,
      top,
      height: view.height,
      depth,
      isGroupHeader,
      expanded,
    });
    top += view.height;
  }
  if (trackViews.length === 0) {
    throw new Error(
      `renderOffscreenTimeline: no renderable tracks ` +
        `(missing: ${missingTracks.join(', ')})`,
    );
  }

  // Webfonts load asynchronously with font-display: swap; drawing text
  // before they are ready would use fallback glyphs and differ between
  // renders, breaking determinism (and visual parity with the live UI).
  // jsdom has no FontFaceSet; guard for test environments.
  if (typeof document !== 'undefined' && document.fonts !== undefined) {
    await document.fonts.ready;
  }

  // Shape: the height is derived from the track set (layout above), so the
  // width is either given explicitly or solved from the aspect ratio.
  const cssHeight = top;
  const cssWidth =
    widthPx ??
    (aspectRatio !== undefined
      ? Math.round(cssHeight * aspectRatio)
      : DEFAULT_WIDTH_PX);
  // With many tracks (tall canvas) the default dpr 2 can exceed the browser
  // canvas limits; negotiate rather than failing a zero-config call.
  const dpr = negotiateDpr(cssWidth, cssHeight, devicePixelRatio);

  // Data resolution: like the interactive path, quantized to a power of two,
  // but computed for `cssWidth / dataResolutionScale` so that (with the
  // default 0.5) a 2x canvas fetches 1x data.
  const maybeResolution = calculateResolution(
    timeSpan,
    Math.max(1, cssWidth / dataResolutionScale),
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
    dpr,
  );

  const colors = getDefaultCanvasColors();
  // The timeline occupies the area right of the shell column and below the
  // time axis row; decorations fill the remaining strips afterwards.
  const timelineRect = new Rect2D({
    left: shellWidth,
    top: axisHeight,
    right: cssWidth,
    bottom: cssHeight,
  });
  const timescale = new TimeScale(timeSpan, {
    left: shellWidth,
    right: cssWidth,
  });

  const timedOutTracks: string[] = [];
  const renderContexts = new Map<TrackView, TrackRenderContext>();
  for (const view of trackViews) {
    // verticalBounds are already canvas-absolute (they include axisHeight).
    const trackRect = new Rect2D({
      left: shellWidth,
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
      timescale: new TimeScale(timeSpan, {left: shellWidth, right: cssWidth}),
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
      await traceEvent('TimelineImage.warmUp', () => warmUp(budget), {
        args: {round: String(rounds)},
      });
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
      scaleX: dpr,
      scaleY: dpr,
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
    // Decorations are drawn after the timeline content, in the same CSS
    // coordinate space (the dpr transform above applies to the 2D ctx too).
    // Opaque backgrounds also clip any gridline overdraw into their strips.
    if (includeTrackShell) {
      drawGroupHeaderRows(d2Ctx, trackBoxes, cssWidth);
      drawTrackShell(d2Ctx, trackBoxes, shellWidth);
    }
    if (includeTimeAxis) {
      drawTimeAxis(d2Ctx, {
        trace,
        timeSpan,
        timescale,
        cssWidth,
        axisHeight,
        shellWidth,
      });
    }
    if (glCtx) {
      glCtx.flush();
    }
  }

  // -------------------------------------------------------------- composite
  traceEvent('TimelineImage.e2e', () => {}, {args: {rounds: String(rounds)}});
  const outCanvas = createCanvas(cssWidth, cssHeight, dpr);
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
    warnings: missingTracks.length > 0 ? ['TRACK_MISSING'] : [],
    devicePixelRatio: dpr,
    rounds,
    perf: {loadMs, drawMs},
  };
}

/**
 * Guardrail negotiation for the output canvas: if the requested pixel
 * density overflows the browser canvas limits, downgrade to 1x (the result
 * reports the effective value); only shapes overflowing even at 1x throw.
 */
export function negotiateDpr(
  cssWidth: number,
  cssHeight: number,
  requestedDpr: number,
): number {
  const fits = (dpr: number) =>
    cssWidth * dpr <= MAX_CANVAS_EDGE_PX &&
    cssHeight * dpr <= MAX_CANVAS_EDGE_PX &&
    cssWidth * dpr * cssHeight * dpr <= MAX_CANVAS_AREA_PX;
  if (fits(requestedDpr)) return requestedDpr;
  if (requestedDpr > 1 && fits(1)) return 1;
  throw new Error(
    `renderOffscreenTimeline: output canvas too large ` +
      `(${cssWidth}x${cssHeight} @${requestedDpr}x)`,
  );
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

/**
 * Map every track URI in the workspace to its tree depth (direct children of
 * the root are depth 0), used for shell indentation offscreen.
 */
function buildUriDepthMap(root: TrackNode): Map<string, number> {
  const map = new Map<string, number>();
  const walk = (node: TrackNode, depth: number) => {
    if (node.uri !== undefined && !map.has(node.uri)) {
      map.set(node.uri, depth);
    }
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };
  walk(root, -1); // The root container itself is not a track level.
  return map;
}

function clipText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (maxWidth <= 4) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 0 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out.length > 0 ? `${out}…` : '';
}

/**
 * Group header rows: the interactive tree paints summary containers with a
 * tinted background across the whole row (collapsed and expanded use
 * different theme colors); expanded headers also flip their text color.
 * Drawn before shell text so the title renders on top.
 */
function drawGroupHeaderRows(
  ctx: CanvasRenderingContext2D,
  boxes: ReadonlyArray<{
    name: string;
    top: number;
    height: number;
    isGroupHeader: boolean;
    expanded: boolean;
  }>,
  cssWidth: number,
): void {
  ctx.save();
  for (const box of boxes) {
    if (!box.isGroupHeader || box.height <= 0) continue;
    ctx.fillStyle = box.expanded
      ? COLOR_TRACK_SUMMARY_EXPANDED
      : COLOR_TRACK_SUMMARY_COLLAPSED;
    ctx.fillRect(0, box.top, cssWidth, box.height);
  }
  ctx.restore();
}

/**
 * Track shell column: names indented by workspace depth, one line per track,
 * with row separators. A canvas-drawn simplification of the interactive
 * DOM shell (no expand arrows or hover affordances), matching its computed
 * styles: weight-300 14px condensed text, ellipsized titles, transparent
 * background (the page background shows through), border-bottom per row.
 */
function drawTrackShell(
  ctx: CanvasRenderingContext2D,
  boxes: ReadonlyArray<{
    name: string;
    top: number;
    height: number;
    depth: number;
    isGroupHeader: boolean;
    expanded: boolean;
  }>,
  shellWidth: number,
): void {
  ctx.save();
  // No shell background fill: the DOM shell is transparent over the page
  // background, so the offscreen image keeps a uniform background too.
  ctx.font = SHELL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const box of boxes) {
    if (box.height <= 0) continue;
    const x = Math.max(0, box.depth) * SHELL_INDENT_PX + SHELL_TITLE_OFFSET_PX;
    ctx.fillStyle =
      box.isGroupHeader && box.expanded
        ? COLOR_TRACK_SUMMARY_EXPANDED_TEXT
        : COLOR_TEXT;
    ctx.fillText(
      clipText(ctx, box.name, shellWidth - 4 - x),
      x,
      // 14px text on a 16px line, one pixel into the row (DOM layout).
      box.top + 13,
    );
    ctx.fillStyle = COLOR_BORDER;
    ctx.fillRect(0, box.top + box.height - 1, shellWidth, 1);
  }
  ctx.restore();
}

/**
 * Time axis row: trace span summary on the left (over the shell column) and
 * major ticks with two-line timecode labels over the content area, mirroring
 * TimeAxisPanel. All formatting is locale-independent (timecode rendering
 * only), keeping the output deterministic (plan T1.11).
 */
function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  opts: {
    trace: TraceImpl;
    timeSpan: HighPrecisionTimeSpan;
    timescale: TimeScale;
    cssWidth: number;
    axisHeight: number;
    shellWidth: number;
  },
): void {
  const {trace, timeSpan, timescale, cssWidth, axisHeight, shellWidth} = opts;
  ctx.save();
  ctx.fillStyle = COLOR_BACKGROUND;
  ctx.fillRect(0, 0, cssWidth, axisHeight);
  ctx.font = `11px ${FONT_COMPACT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const timespan = timeSpan.toTimeSpan();
  // Same labels as TimeAxisPanel.renderOffsetTimestamp: a bold label
  // followed by the value, default (timecode) formatting only, which is
  // locale-independent.
  const startTc = Time.toTimecode(timespan.start).toString(' ');
  const durText = formatDuration(trace, timespan.duration);
  const drawLabelAndValue = (label: string, value: string, y: number) => {
    ctx.font = `bold 11px ${FONT_COMPACT}`;
    const labelWidth = ctx.measureText(label).width;
    ctx.fillStyle = COLOR_TEXT_MUTED;
    ctx.fillText(label, 6, y, shellWidth - 12);
    ctx.font = `11px ${FONT_COMPACT}`;
    ctx.fillText(value, 6 + labelWidth, y, shellWidth - 12 - labelWidth);
  };
  drawLabelAndValue('Start: ', startTc, 10);
  drawLabelAndValue('Duration: ', durText, 20);

  const contentWidth = cssWidth - shellWidth;
  if (contentWidth > 0 && timespan.duration > 0n) {
    const maxMajorTicks = getMaxMajorTicks(contentWidth);
    const offset = trace.timeline.getTimeAxisOrigin();
    for (const {type, time} of generateTicks(timespan, maxMajorTicks, offset)) {
      if (type !== TickType.MAJOR) continue;
      const px = Math.floor(timescale.timeToPx(time));
      ctx.fillStyle = COLOR_BORDER;
      ctx.fillRect(px, 0, 1, axisHeight);
      const domain = trace.timeline.toDomainTime(time);
      const tc = Time.toTimecode(domain);
      ctx.fillStyle = COLOR_TEXT_MUTED;
      ctx.fillText(tc.dhhmmss, px + 5, 10);
      ctx.fillText(tc.subsec('\u2009'), px + 5, 20);
    }
  }
  ctx.restore();
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
