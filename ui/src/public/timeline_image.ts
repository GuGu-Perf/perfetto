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
   * Subset of tracks to pin to the top of the image, in order. Each entry
   * must also be part of the rendered set (explicitly or via the default);
   * entries which are not renderable produce a TRACK_NOT_RENDERED warning.
   */
  readonly pinTracks?: readonly string[];
  /**
   * Time span to render, as {start, end} in nanoseconds. Defaults to the
   * current visible window.
   */
  readonly timeSpan?: {readonly start: time; readonly end: time};
  /** Width of the produced image in CSS pixels. Default: 1920. */
  readonly widthPx?: number;
  /** Device pixel ratio of the canvas. Default: 2. */
  readonly devicePixelRatio?: number;
  /**
   * Data is fetched at this fraction of the canvas resolution. Default 0.5
   * (1x data on a 2x canvas); 1 disables the decoupling.
   */
  readonly dataResolutionScale?: number;
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
}

export interface TimelineImageResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly trackBoxes: readonly TimelineImageTrackBox[];
  readonly warnings: readonly TimelineImageWarning[];
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
