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
   * Ordered list of track URIs to render, top to bottom. Defaults to all
   * tracks in the current workspace.
   */
  readonly trackUris?: readonly string[];
  /**
   * Resolve tracks by human-readable name (and optional thread/process id),
   * e.g. {name: 'RenderThread', tid: 4543}. Matches workspace tracks whose
   * title equals `name`, or `"<name> <tid>"` when tid is given. Resolved
   * URIs are appended to `trackUris` (deduplicated); unmatched entries
   * produce a TRACK_MISSING warning.
   */
  readonly trackNames?: readonly {
    readonly name: string;
    readonly tid?: number;
    readonly pid?: number;
  }[];
  /**
   * Subset of tracks to pin to the top of the image, in order. Each entry
   * must also be part of the rendered set (explicitly or via the default);
   * entries which are not renderable produce a TRACK_NOT_RENDERED warning.
   */
  readonly pinTracks?: readonly string[];
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
   * `aspectRatio` (they constrain the same degree of freedom: the height is
   * always derived from the track set). Default: 1920 when neither is given.
   */
  readonly widthPx?: number;
  /**
   * Target width/height ratio of the produced image (e.g. 4/3). The height
   * is determined by the track set, so the width becomes
   * round(height * aspectRatio). Mutually exclusive with `widthPx`.
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
   * Per-track data loading budget in milliseconds. Tracks which do not
   * settle in time are drawn as-is and reported via warnings/timeouts.
   * Default: 5000.
   */
  readonly perTrackTimeoutMs?: number;
  /** Output encoding. Default: 'image/png'. */
  readonly format?: 'image/png' | 'image/jpeg';
}

/** Warning kinds reported on a completed TimelineImageResult. */
export type TimelineImageWarning =
  'TIMELINE_UNAVAILABLE' | 'TRACK_MISSING' | 'TRACK_NOT_RENDERED' | 'TIMEOUT';

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
  readonly trackBoxes: readonly TimelineImageTrackBox[];
  readonly warnings: readonly TimelineImageWarning[];
  /** Phase timings in milliseconds (see plan §6.5 dual-trail observability). */
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
