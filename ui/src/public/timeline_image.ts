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
   * Ordered list of workspace track URIs to render, top to bottom — the
   * list order is the render order, so "pinning" is putting a URI first.
   * Required: rendering is an act of deliberate selection; pass the whole
   * workspace explicitly if that is what you want (see `listTracks` to
   * discover URIs).
   *
   * URI shapes of interest (as built by the current built-in plugins; the
   * SQL tables are the stable contract, the URI spellings are not):
   * - `/thread_<utid>`: every capability track of that thread (state,
   *   slices, and anything else the trace provides). Obtain the utid via
   *   `select utid from thread where tid = <tid>`.
   * - `/process_<upid>/thread_<utid>_state` (or `/thread_<utid>_state` for
   *   threads without a process): exactly the thread's CPU state track.
   * - `/slice_<trackId>`: exactly the thread's slice track; the id comes
   *   from `select t.id from track t join thread_track tt on t.id = tt.id
   *   where tt.utid = <utid>`.
   * A URI pointing at a group node (process, thread, summary groups)
   * expands to its leaf tracks. Duplicate URIs render once, at the
   * position of their first occurrence. Unknown URIs reject the render
   * with an error listing them.
   */
  readonly trackUris: readonly string[];
  /**
   * Exact canvas height in CSS pixels. The track content has a natural
   * height (time axis + track stack); when `heightPx` exceeds it the
   * remainder is background padding (useful for fixed-size report grids),
   * when it is smaller the content is clipped and the result carries a
   * `TRUNCATED` warning. Default: the canvas is exactly as tall as the
   * content.
   */
  readonly heightPx?: number;
  /**
   * Time span to render, as {start, end} in nanoseconds. Default: the
   * whole trace (stateless — the render never depends on what the
   * interactive UI happens to show). Strings are accepted and parsed as
   * BigInt, so callers crossing a JSON boundary (e.g. postMessage) can
   * pass timestamps serialized as strings.
   */
  readonly timeSpan?: {
    readonly start: time | string;
    readonly end: time | string;
  };
  /**
   * Width of the produced image in CSS pixels. Default: 1920. For a fixed
   * aspect ratio instead of a fixed width, render once, read `height` from
   * the result (it does not depend on the width), and re-render with
   * `widthPx = round(height * ratio)` — the output is identical.
   */
  readonly widthPx?: number;
  /** Device pixel ratio of the canvas (image crispness). Default: 2. */
  readonly devicePixelRatio?: number;
  /**
   * Output encoding. Default: 'image/png'. JPEG uses the browser's default
   * encoder quality (no quality knob by design — keep the surface minimal).
   */
  readonly format?: 'image/png' | 'image/jpeg';
}

/** Warning kinds reported on a completed TimelineImageResult. */
export type TimelineImageWarning =
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
 * rendering rejects with an error.
 */
export interface TimelineImageManager {
  renderTimelineImage(opts: TimelineImageOptions): Promise<TimelineImageResult>;
}
