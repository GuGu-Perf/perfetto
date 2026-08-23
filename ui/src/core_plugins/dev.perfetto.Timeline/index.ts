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
import {AppImpl} from '../../core/app_impl';
import type {TraceImpl} from '../../core/trace_impl';
import type {Flag} from '../../public/feature_flag';
import type {PerfettoPlugin} from '../../public/plugin';
import {TimelinePage} from './timeline_page';
import {renderOffscreenTimeline} from './offscreen_timeline_renderer';
import {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import type {time} from '../../base/time';
import {Time} from '../../base/time';
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
 * validates the selection and the time span.
 */
async function renderTimelineImageAdapter(
  trace: TraceImpl,
  opts: TimelineImageOptions,
): Promise<TimelineImageRenderOutput> {
  // TS callers are forced by the required field; the postMessage path feeds
  // raw JSON into this signature, so validate again at the boundary.
  // Rendering is an act of deliberate selection; there is no default set.
  if (opts.trackUris === undefined || opts.trackUris.length === 0) {
    throw new Error(
      'renderTimelineImage: trackUris is required (and must not be empty). ' +
        'Discover URIs with the listTracks message or via SQL.',
    );
  }
  // A trace can be loaded (traceInfo available) while plugins are still
  // building the workspace; rendering then would mis-report every URI as
  // missing. Wait briefly for the first tracks to appear.
  const workspaceHasTracks = () => {
    let any = false;
    const visit = (n: TrackNode) => {
      if (n.uri !== undefined || n.children.length > 0) any = true;
      for (const c of n.children) visit(c);
    };
    visit(trace.defaultWorkspace.tracks);
    return any;
  };
  // isLoadingTrace stays true until loadTrace() resolves, which happens
  // only after every plugin's onTraceLoad has built its tracks: waiting on
  // both closes the partial-workspace race.
  const ready = () => !AppImpl.instance.isLoadingTrace && workspaceHasTracks();
  const waitDeadline = performance.now() + 30_000;
  while (!ready() && performance.now() < waitDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready()) {
    throw new Error(
      'renderTimelineImage: trace/workspace not ready after 30s ' +
        '(still loading or no tracks) — retry once the trace is loaded',
    );
  }

  // Accept plain {start, end} time spans (e.g. from postMessage or JSON,
  // where BigInts arrive as strings) by normalizing to
  // HighPrecisionTimeSpan.
  const info = trace.traceInfo;
  const toTime = (t: time | string): time =>
    typeof t === 'string' ? Time.fromRaw(BigInt(t)) : t;
  const timeSpan = opts.timeSpan
    ? HighPrecisionTimeSpan.fromTime(
        toTime(opts.timeSpan.start),
        toTime(opts.timeSpan.end),
      )
    : // Stateless default: the whole trace, never whatever the interactive
      // UI happens to be showing.
      HighPrecisionTimeSpan.fromTime(
        info?.start ?? Time.ZERO,
        info?.end ?? Time.ZERO,
      );
  // A span entirely outside the trace bounds would render a blank image that
  // still looks like a valid render; reject it up front. Partial overlap is
  // fine: the tracks simply have no data before/after the trace.
  if (
    info !== undefined &&
    (timeSpan.end.lte(info.start) || timeSpan.start.gte(info.end))
  ) {
    throw new Error(
      `renderTimelineImage: timeSpan ` +
        `[${timeSpan.start.toTime()}, ${timeSpan.end.toTime()}] does not ` +
        `overlap trace bounds [${info.start}, ${info.end}]`,
    );
  }

  const output = await renderOffscreenTimeline({
    trace,
    trackUris: opts.trackUris,
    timeSpan,
    widthPx: opts.widthPx,
    heightPx: opts.heightPx,
    devicePixelRatio: opts.devicePixelRatio,
  });
  return output;
}
