// Copyright (C) 2018 The Android Open Source Project
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

import m from 'mithril';
import z from 'zod';
import type {AppImpl} from '../../core/app_impl';
import type {TraceImpl} from '../../core/trace_impl';
import type {Flag} from '../../public/feature_flag';
import type {PerfettoPlugin} from '../../public/plugin';
import {TimelinePage} from './timeline_page';
import {renderOffscreenTimeline} from './offscreen_timeline_renderer';
import {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import type {TimelineImageOptions} from '../../public/timeline_image';
import type {TimelineImageRenderOutput} from '../../core/timeline_image_manager';
import type {TrackNode} from '../../public/workspace';
import {
  DEFAULT_TRACK_MIN_HEIGHT_PX,
  MINIMUM_TRACK_MIN_HEIGHT_PX,
  TRACK_MIN_HEIGHT_SETTING,
} from './track_view';

export default class TimelinePlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.Timeline';
  static readonly description = 'The main timeline view';
  private static minimapFlag: Flag;

  static onActivate(app: AppImpl): void {
    // This setting is referenced in the track view by name
    app.settings.register({
      id: TRACK_MIN_HEIGHT_SETTING,
      name: 'Track Height',
      description:
        'Minimum height of tracks in the trace viewer page, in pixels.',
      schema: z.number().int().min(MINIMUM_TRACK_MIN_HEIGHT_PX),
      defaultValue: DEFAULT_TRACK_MIN_HEIGHT_PX,
    });

    TimelinePlugin.minimapFlag = app.featureFlags.register({
      id: 'overviewVisible',
      name: 'Overview Panel',
      description: 'Show the panel providing an overview of the trace',
      defaultValue: true,
    });
  }

  async onTraceLoad(trace: TraceImpl): Promise<void> {
    trace.timelineImage.registerRenderer((opts) =>
      renderTimelineImageAdapter(trace, opts),
    );

    trace.pages.registerPage({
      route: '/viewer',
      render: () => {
        return m(TimelinePage, {
          trace,
          showMinimap: TimelinePlugin.minimapFlag.get(),
        });
      },
    });

    trace.sidebar.addMenuItem({
      section: 'current_trace',
      sortOrder: 10,
      text: 'Timeline',
      href: '#!/viewer',
      icon: 'line_style',
    });
  }
}

/**
 * Adapter between the public TimelineImageManager and the offscreen renderer:
 * resolves the default track set, applies pin ordering and maps missing
 * tracks to warnings consumed by the caller of the render function.
 */
async function renderTimelineImageAdapter(
  trace: TraceImpl,
  opts: Partial<TimelineImageOptions>,
): Promise<TimelineImageRenderOutput> {
  const defaultUris = collectLeafTrackUris(trace.defaultWorkspace.tracks);
  const requested = opts.trackUris ?? defaultUris;
  const pinned = opts.pinTracks ?? [];
  const pinnedSet = new Set(pinned);
  const ordered = [
    ...pinned.filter((uri) => requested.includes(uri)),
    ...requested.filter((uri) => !pinnedSet.has(uri)),
  ];

  // Accept plain {start, end} time spans (e.g. from postMessage) by
  // normalizing to HighPrecisionTimeSpan; default to the visible window.
  const timeSpan = opts.timeSpan
    ? HighPrecisionTimeSpan.fromTime(opts.timeSpan.start, opts.timeSpan.end)
    : trace.timeline.visibleWindow;

  const output = await renderOffscreenTimeline({
    trace,
    trackUris: ordered,
    timeSpan,
    widthPx: opts.widthPx ?? 1920,
    devicePixelRatio: opts.devicePixelRatio,
    dataResolutionScale: opts.dataResolutionScale,
    perTrackTimeoutMs: opts.perTrackTimeoutMs,
  });
  return output;
}

function collectLeafTrackUris(node: TrackNode): string[] {
  const uris: string[] = [];
  if (node.uri) {
    uris.push(node.uri);
  }
  for (const child of node.children) {
    uris.push(...collectLeafTrackUris(child));
  }
  return uris;
}
