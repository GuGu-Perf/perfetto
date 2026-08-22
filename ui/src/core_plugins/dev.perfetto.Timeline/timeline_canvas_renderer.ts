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
 * The timeline canvas drawing sequence, extracted from TrackTreeView so that
 * it can be shared between the on-screen timeline and future consumers (e.g.
 * an offscreen timeline image renderer).
 *
 * Everything in this module is a pure function of its arguments: given the
 * same trace state and arguments it issues the same draw calls in the same
 * order. Session-bound concerns that only make sense for the interactive
 * component (interaction zone updates, perf stat bookkeeping) remain in
 * TrackTreeView.
 */

import {hex} from 'color-convert';
import {type Rect2D, type Size2D, Transform1D} from '../../base/geom';
import type {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import type {time} from '../../base/time';
import type {TimeScale} from '../../base/time_scale';
import type {Renderer} from '../../base/renderer';
import {drawVerticalLineAtTime} from '../../base/vertical_line_helper';
import type {TraceImpl} from '../../core/trace_impl';
import type {PerfStats} from '../../core/perf_stats';
import {
  COLOR_ACCENT,
  COLOR_BORDER_SECONDARY,
} from '../../frontend/css_constants';
import type {CanvasColors} from '../../public/canvas_colors';
import type {Note, SpanNote} from '../../public/note';
import type {Selection} from '../../public/selection';
import type {SnapPoint} from '../../public/track';
import type {TrackNode} from '../../public/workspace';
import {renderFlows} from './flow_events_renderer';
import {generateTicks, getMaxMajorTicks, TickType} from './gridline_helper';
import type {TrackView} from './track_view';
import type {
  InProgressAreaSelection,
  InProgressHandleDrag,
} from './track_tree_view';

export interface TimelineCanvasRenderArgs {
  // Canvas 2D context for text and line drawing.
  readonly ctx: CanvasRenderingContext2D;
  // Full canvas size, in CSS pixels.
  readonly size: Size2D;
  // The drawable timeline area (everything right of the track shell).
  readonly timelineRect: Rect2D;
  // Pre-built timescale mapping the visible window onto the timeline rect.
  readonly timescale: TimeScale;
  readonly visibleWindow: HighPrecisionTimeSpan;
  // The tracks to render, with their pre-computed vertical bounds.
  readonly renderedTracks: ReadonlyArray<TrackView>;
  // Tracks are only drawn when they overlap this rect (virtual scrolling).
  readonly floatingCanvasRect: Rect2D;
  // Root workspace node, used for flow arrow routing.
  readonly rootNode: TrackNode;
  // Read-only access to trace state (flows, notes, selection, overlays).
  readonly trace: TraceImpl;
  readonly colors: CanvasColors;
  readonly renderer: Renderer;
  // Origin of the time axis (see Trace#timeline#getTimeAxisOrigin).
  readonly tickOrigin: time;
  // Per-track perf stats passthrough for TrackView#drawCanvas.
  readonly perfStatsEnabled: boolean;
  readonly trackPerfStats: WeakMap<TrackNode, PerfStats>;
  // In-progress drag overlays. Only set by the interactive component.
  readonly areaDrag?: InProgressAreaSelection;
  readonly handleDrag?: InProgressHandleDrag;
  readonly currentSnapPoint?: SnapPoint;
}

export interface TimelineCanvasRenderResult {
  // Number of tracks that passed the overlap filter and were drawn.
  readonly tracksOnCanvas: number;
}

/**
 * Draws the full timeline canvas sequence: clip → grid lines → tracks →
 * flows → note/cursor verticals → area selection → overlays.
 *
 * The clip is scoped to the whole sequence with `using`, matching the
 * original inline behaviour in TrackTreeView#drawCanvas.
 */
export function renderTimelineCanvas(
  args: TimelineCanvasRenderArgs,
): TimelineCanvasRenderResult {
  const {ctx, size, timelineRect, renderer} = args;

  // Clip to the timeline area for WebGL rendering
  using _clip = renderer.clip(
    timelineRect.left,
    timelineRect.top,
    timelineRect.width,
    timelineRect.height,
  );

  drawTimelineGridLines(
    renderer,
    args.timescale,
    timelineRect,
    args.tickOrigin,
  );

  // Render all track content (WebGL rectangles + Canvas 2D text)
  const tracksOnCanvas = drawTracksOnCanvas(
    args.renderedTracks,
    args.floatingCanvasRect,
    size,
    ctx,
    timelineRect,
    args.visibleWindow,
    args.colors,
    renderer,
    args.perfStatsEnabled,
    args.trackPerfStats,
  );

  renderFlows(
    args.trace,
    ctx,
    size,
    args.renderedTracks,
    args.rootNode,
    args.timescale,
  );
  drawHoveredNoteVertical(
    ctx,
    args.timescale,
    size,
    args.trace.timeline.hoveredNoteTimestamp,
  );
  drawHoveredCursorVertical(
    ctx,
    args.timescale,
    size,
    args.trace.timeline.hoverCursorTimestamp,
  );
  drawNoteVerticals(ctx, args.timescale, size, args.trace.notes.notes);
  drawAreaSelection(
    ctx,
    args.timescale,
    size,
    args.trace.selection.selection,
    args.areaDrag,
    args.handleDrag,
    args.currentSnapPoint,
  );

  args.trace.tracks.overlays.forEach((overlay) => {
    overlay.render(ctx, args.timescale, size, args.renderedTracks, args.colors);
  });

  return {tracksOnCanvas};
}

/**
 * Draws vertical grid lines for every major tick, as 1px wide slices
 * spanning the height of the timeline rect.
 */
export function drawTimelineGridLines(
  renderer: Renderer,
  timescale: TimeScale,
  timelineRect: Rect2D,
  tickOrigin: time,
): void {
  if (timelineRect.width <= 0 || timescale.timeSpan.duration <= 0n) {
    return;
  }

  const maxMajorTicks = getMaxMajorTicks(timelineRect.width);

  // Collect all major tick positions
  const tickPositions: number[] = [];
  for (const {type, time} of generateTicks(
    timescale.timeSpan.toTimeSpan(),
    maxMajorTicks,
    tickOrigin,
  )) {
    if (type === TickType.MAJOR) {
      tickPositions.push(Math.floor(timescale.timeToPx(time)));
    }
  }

  if (tickPositions.length === 0) return;

  // Create buffers for WebGL rendering
  const count = tickPositions.length;
  const starts = new Float32Array(count);
  const ends = new Float32Array(count);
  const colors = new Uint32Array(count);
  const patterns = new Uint8Array(count);
  const depths = new Uint16Array(count);
  const gridColor = cssColorToRgba(COLOR_BORDER_SECONDARY);

  for (let i = 0; i < count; i++) {
    starts[i] = tickPositions[i];
    ends[i] = tickPositions[i] + 1;
    colors[i] = gridColor;
    patterns[i] = 0;
    depths[i] = 0;
  }

  // Use the slice shader to draw gridlines as 1px wide slices spanning the
  // height of the timeline. This is sort of abusing the slice renderer, but
  // it allows us to draw gridlines without needing a separate shader program,
  // and seeing as slices are just rectangles, it's a decent fit.
  renderer.drawSlices(
    {
      starts,
      ends,
      depths,
      colors,
      patterns,
      count,
    },
    {
      rowHeight: timelineRect.height,
    },
    Transform1D.Identity,
  );
}

/** Renders every track overlapping the floating canvas rect. */
export function drawTracksOnCanvas(
  renderedTracks: ReadonlyArray<TrackView>,
  floatingCanvasRect: Rect2D,
  size: Size2D,
  ctx: CanvasRenderingContext2D,
  timelineRect: Rect2D,
  visibleWindow: HighPrecisionTimeSpan,
  colors: CanvasColors,
  renderer: Renderer,
  perfStatsEnabled: boolean,
  trackPerfStats: WeakMap<TrackNode, PerfStats>,
): number {
  let tracksOnCanvas = 0;
  for (const trackView of renderedTracks) {
    const {verticalBounds} = trackView;
    if (
      floatingCanvasRect.overlaps({
        ...verticalBounds,
        left: 0,
        right: size.width,
      })
    ) {
      trackView.drawCanvas(
        ctx,
        timelineRect,
        visibleWindow,
        perfStatsEnabled,
        trackPerfStats,
        colors,
        renderer,
      );
      ++tracksOnCanvas;
    }
  }
  return tracksOnCanvas;
}

function drawAreaSelection(
  ctx: CanvasRenderingContext2D,
  timescale: TimeScale,
  size: Size2D,
  selection: Selection,
  areaDrag: InProgressAreaSelection | undefined,
  handleDrag: InProgressHandleDrag | undefined,
  currentSnapPoint: SnapPoint | undefined,
): void {
  if (areaDrag) {
    const rect = areaDrag.rect(timescale);
    const snapPx = currentSnapPoint
      ? timescale.timeToPx(currentSnapPoint.time)
      : undefined;

    ctx.strokeStyle = COLOR_ACCENT;
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Always draw top and bottom
    ctx.moveTo(rect.x, rect.y);
    ctx.lineTo(rect.x + rect.width, rect.y);
    ctx.moveTo(rect.x, rect.y + rect.height);
    ctx.lineTo(rect.x + rect.width, rect.y + rect.height);

    // Draw left edge if not snapped
    if (snapPx === undefined || Math.abs(snapPx - rect.x) > 1) {
      ctx.moveTo(rect.x, rect.y);
      ctx.lineTo(rect.x, rect.y + rect.height);
    }

    // Draw right edge if not snapped
    if (snapPx === undefined || Math.abs(snapPx - (rect.x + rect.width)) > 1) {
      ctx.moveTo(rect.x + rect.width, rect.y);
      ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
    }

    ctx.stroke();

    // Draw full-height dashed line if snapped
    if (snapPx !== undefined) {
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(snapPx, 0);
      ctx.lineTo(snapPx, size.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (handleDrag) {
    const rect = handleDrag.hBounds(timescale);
    const snapPx = currentSnapPoint
      ? timescale.timeToPx(currentSnapPoint.time)
      : undefined;

    ctx.strokeStyle = COLOR_ACCENT;
    ctx.lineWidth = 1;

    // Draw left boundary
    const leftSnapped =
      snapPx !== undefined && Math.abs(snapPx - rect.left) < 1;
    if (leftSnapped) {
      ctx.setLineDash([4, 4]);
    }
    ctx.beginPath();
    ctx.moveTo(rect.left, 0);
    ctx.lineTo(rect.left, size.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw right boundary
    const rightSnapped =
      snapPx !== undefined && Math.abs(snapPx - rect.right) < 1;
    if (rightSnapped) {
      ctx.setLineDash([4, 4]);
    }
    ctx.beginPath();
    ctx.moveTo(rect.right, 0);
    ctx.lineTo(rect.right, size.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (selection.kind === 'area') {
    const startPx = timescale.timeToPx(selection.start);
    const endPx = timescale.timeToPx(selection.end);

    ctx.strokeStyle = COLOR_ACCENT;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(startPx, 0);
    ctx.lineTo(startPx, size.height);
    ctx.stroke();
    ctx.closePath();

    ctx.beginPath();
    ctx.moveTo(endPx, 0);
    ctx.lineTo(endPx, size.height);
    ctx.stroke();
    ctx.closePath();
  }
}

function drawHoveredCursorVertical(
  ctx: CanvasRenderingContext2D,
  timescale: TimeScale,
  size: Size2D,
  hoverCursorTimestamp: time | undefined,
): void {
  if (hoverCursorTimestamp !== undefined) {
    drawVerticalLineAtTime(
      ctx,
      timescale,
      hoverCursorTimestamp,
      size.height,
      `#344596`,
    );
  }
}

function drawHoveredNoteVertical(
  ctx: CanvasRenderingContext2D,
  timescale: TimeScale,
  size: Size2D,
  hoveredNoteTimestamp: time | undefined,
): void {
  if (hoveredNoteTimestamp !== undefined) {
    drawVerticalLineAtTime(
      ctx,
      timescale,
      hoveredNoteTimestamp,
      size.height,
      `#aaa`,
    );
  }
}

function drawNoteVerticals(
  ctx: CanvasRenderingContext2D,
  timescale: TimeScale,
  size: Size2D,
  notes: ReadonlyMap<string, Note | SpanNote>,
): void {
  // All marked areas should have semi-transparent vertical lines
  // marking the start and end.
  for (const note of notes.values()) {
    if (note.noteType === 'SPAN') {
      const transparentNoteColor =
        'rgba(' + hex.rgb(note.color.substr(1)).toString() + ', 0.65)';
      drawVerticalLineAtTime(
        ctx,
        timescale,
        note.start,
        size.height,
        transparentNoteColor,
        1,
      );
      drawVerticalLineAtTime(
        ctx,
        timescale,
        note.end,
        size.height,
        transparentNoteColor,
        1,
      );
    } else if (note.noteType === 'DEFAULT') {
      drawVerticalLineAtTime(
        ctx,
        timescale,
        note.timestamp,
        size.height,
        note.color,
      );
    }
  }
}

// Cache for CSS color to packed RGBA conversion
const cssColorCache = new Map<string, number>();

// Convert a CSS color string to packed RGBA (0xRRGGBBAA)
function cssColorToRgba(cssColor: string): number {
  const cached = cssColorCache.get(cssColor);
  if (cached !== undefined) return cached;

  // Use an offscreen canvas to parse CSS color
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const imageData = ctx.getImageData(0, 0, 1, 1);
  const [r, g, b, a] = imageData.data;
  const packed = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

  cssColorCache.set(cssColor, packed);
  return packed;
}
