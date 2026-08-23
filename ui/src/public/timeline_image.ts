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

import type {time} from '../base/time';

/**
 * Options for rendering a timeline image offscreen.
 *
 * The image is a fresh composition of the requested tracks for the requested
 * time span: it never contains page chrome (sidebar, omnibox, dialogs) — only
 * the timeline content selected here.
 */
export interface TimelineImageOptions {
  /**
   * Ordered list of track URIs to render, top to bottom — the list order is
   * the render order, so "pinning" is just putting a uri first. Defaults to
   * all tracks in the current workspace.
   *
   * URI shapes of interest (as built by the current built-in plugins; the
   * SQL tables are the stable contract, the URI spellings are not):
   * - `/thread_<utid>`: every capability track of that thread (state,
   *   slices, and anything else the trace provides). Obtain the utid via
   *   `select utid from thread where tid = <tid>`.
   * - `/process_<upid>/thread_<utid>_state` (or `/thread_<utid>_state` for
   *   threads without a process): exactly the thread's CPU state track; the
   *   upid comes from the same query (`select utid, upid from thread ...`).
   * - `/slice_<trackId>`: exactly the thread's slice track; the id comes
   *   from `select t.id from track t join thread_track tt on t.id = tt.id
   *   where tt.utid = <utid>`.
   * Alternatively, discover URIs at runtime with the `listTracks` embedding
   * message, which returns the live workspace tree.
   * Unmatched URIs reject the render with an error listing them.
   */
  readonly trackUris?: readonly string[];
  /**
   * Exact canvas height in CSS pixels. The track content has a natural
   * height (time axis + track stack); when `heightPx` exceeds it the
   * remainder is background padding (useful for fixed-size report grids),
   * when it is smaller the content is clipped and the result carries a
   * `TRUNCATED` warning. Default: the canvas is exactly as tall as the
   * content (the zero-config default composition is capped at 2160 CSS px
   * instead).
   */
  readonly heightPx?: number;
  /**
   * Time span to render, as {start, end} in nanoseconds. Defaults to the
   * current visible window. Strings are accepted and parsed as BigInt, so
   * callers crossing a JSON boundary (e.g. postMessage) can pass timestamps
   * serialized as strings.
   */
  readonly timeSpan?: {
    readonly start: time | string;
    readonly end: time | string;
  };
  /**
   * Width of the produced image in CSS pixels. Mutually exclusive with
   * `aspectRatio` (they constrain the same degree of freedom: the width).
   * Default: 1920 when neither is given.
   */
  readonly widthPx?: number;
  /**
   * Target width/height ratio of the produced image (e.g. 4/3). The canvas
   * height (track content, or `heightPx` when given) determines the width:
   * `round(height * aspectRatio)`. Mutually exclusive with `widthPx`.
   */
  readonly aspectRatio?: number;
  /** Device pixel ratio of the canvas (image crispness). Default: 2. */
  readonly devicePixelRatio?: number;
  /**
   * Data is fetched at this fraction of the canvas resolution. Default 0.5
   * (1x data on a 2x canvas); 1 disables the decoupling.
   */
  readonly dataResolutionScale?: number;
  /**
   * Draw the track shell column (track names, indentation) on the left, as
   * the interactive timeline does. Default: true. Part of the image is a
   * canvas-drawn simplification of the DOM shell (no expand arrows or hover
   * affordances).
   */
  readonly includeTrackShell?: boolean;
  /**
   * Draw the time axis row (ticks + locale-independent timecode labels)
   * above the tracks. Default: true.
   */
  readonly includeTimeAxis?: boolean;
  /**
   * Per-track data loading budget in milliseconds. The first warm-up round
   * waits up to this budget per track; subsequent fixed-point rounds (which
   * only settle second-order queries) are capped at 5s regardless. Tracks
   * which do not settle are drawn as-is and reported via warnings.
   * Default: 5000.
   */
  readonly perTrackTimeoutMs?: number;
  /** Output encoding. Default: 'image/png'. */
  readonly format?: 'image/png' | 'image/jpeg';
}

/** Warning kinds reported on a completed TimelineImageResult. */
export type TimelineImageWarning =
  | 'TIMELINE_UNAVAILABLE'
  | 'TIMEOUT'
  // The zero-config default composition was truncated at the default
  // height cap (2160 CSS px); request explicit trackUris for everything.
  | 'TRUNCATED';

/** Bounding box of a rendered track, in CSS pixels. */
export interface TimelineImageTrackBox {
  readonly uri: string;
  readonly name: string;
  readonly top: number;
  readonly height: number;
  /** Nesting depth in the workspace tree (0 = top level), for indentation. */
  readonly depth: number;
  /** True for group (summary/headless container) 18px title rows. */
  readonly isGroupHeader?: boolean;
  /** Group expansion state at render time (group headers only). */
  readonly expanded?: boolean;
}

export interface TimelineImageResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  /** Effective device pixel ratio (may be downgraded on very tall outputs). */
  readonly devicePixelRatio: number;
  readonly trackBoxes: readonly TimelineImageTrackBox[];
  readonly warnings: readonly TimelineImageWarning[];
  /** Phase timings in milliseconds (dual-trail with metatrace events). */
  readonly perf: {
    readonly loadMs: number;
    readonly drawMs: number;
    readonly encodeMs: number;
    readonly elapsedMs: number;
  };
}

/**
 * Manager for offscreen timeline image rendering.
 *
 * The implementation lives in core but the actual rendering is contributed by
 * the timeline plugin at trace-load time (registration inversion, mirroring
 * MinimapManager). If no renderer is registered (timeline plugin absent),
 * rendering fails with a TIMELINE_UNAVAILABLE warning.
 */
export interface TimelineImageManager {
  renderTimelineImage(
    opts?: Partial<TimelineImageOptions>,
  ): Promise<TimelineImageResult>;
}
