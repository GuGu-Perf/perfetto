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

import type {
  TimelineImageManager,
  TimelineImageOptions,
  TimelineImageResult,
  TimelineImageTrackBox,
  TimelineImageWarning,
} from '../public/timeline_image';

/**
 * Intermediate representation handed from the timeline plugin's renderer to
 * this manager; the manager owns encoding & the public result shape.
 */
export interface TimelineImageRenderOutput {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly trackBoxes: readonly TimelineImageTrackBox[];
  readonly timedOutTracks: readonly string[];
  readonly warnings: readonly TimelineImageWarning[];
  readonly devicePixelRatio?: number;
  readonly perf?: {loadMs: number; drawMs: number};
}

export type TimelineImageRenderFn = (
  opts: Partial<TimelineImageOptions>,
) => Promise<TimelineImageRenderOutput>;

export class TimelineImageManagerImpl implements TimelineImageManager {
  private renderer?: TimelineImageRenderFn;

  registerRenderer(fn: TimelineImageRenderFn): void {
    this.renderer = fn;
  }

  async renderTimelineImage(
    opts: Partial<TimelineImageOptions> = {},
  ): Promise<TimelineImageResult> {
    if (!this.renderer) {
      throw new Error(
        'renderTimelineImage: no timeline renderer registered ' +
          '(timeline plugin absent?)',
      );
    }
    const startMs = performance.now();
    const output = await this.renderer(opts);
    const encodeStart = performance.now();
    const blob = await canvasToBlob(output.canvas, opts.format ?? 'image/png');
    const encodeMs = performance.now() - encodeStart;
    const warnings: TimelineImageWarning[] = [...output.warnings];
    if (output.timedOutTracks.length > 0) {
      warnings.push('TIMEOUT');
    }
    return {
      blob,
      width: output.width,
      height: output.height,
      trackBoxes: output.trackBoxes,
      devicePixelRatio: output.devicePixelRatio ?? opts.devicePixelRatio ?? 2,
      warnings,
      perf: {
        loadMs: output.perf?.loadMs ?? 0,
        drawMs: output.perf?.drawMs ?? 0,
        encodeMs,
        elapsedMs: performance.now() - startMs,
      },
    };
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: 'image/png' | 'image/jpeg',
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('renderTimelineImage: encoding failed'));
        }
      },
      format,
      // Mild quality floor for JPEG; ignored for PNG.
      format === 'image/jpeg' ? 0.92 : undefined,
    );
  });
}
