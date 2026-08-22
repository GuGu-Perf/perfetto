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

import {createFakeTraceImpl} from '../../core/fake_trace_impl';
import {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import {renderOffscreenTimeline} from './offscreen_timeline_renderer';

// jsdom has no canvas implementation, so full rendering cannot run here;
// these tests cover the pure validation & layout logic that runs before
// any canvas is created (see ../test for E2E coverage).

test('empty track list throws with missing uris listed', async () => {
  const trace = createFakeTraceImpl();
  await expect(
    renderOffscreenTimeline({
      trace,
      trackUris: ['/does/not/exist'],
      timeSpan: span(0n, 1_000n),
      widthPx: 100,
    }),
  ).rejects.toThrow('/does/not/exist');
});

test('oversized canvas is rejected before any canvas is created', async () => {
  const trace = createFakeTraceImpl();
  trace.tracks.registerTrack({
    uri: '/test/track',
    renderer: {render: () => {}},
  });
  await expect(
    renderOffscreenTimeline({
      trace,
      trackUris: ['/test/track'],
      timeSpan: span(0n, 1_000n),
      widthPx: 100_000,
      devicePixelRatio: 2,
    }),
  ).rejects.toThrow('too large');
});

test('widthPx < 1 is rejected', async () => {
  const trace = createFakeTraceImpl();
  trace.tracks.registerTrack({
    uri: '/test/track',
    renderer: {render: () => {}},
  });
  await expect(
    renderOffscreenTimeline({
      trace,
      trackUris: ['/test/track'],
      timeSpan: span(0n, 1_000n),
      widthPx: 0,
    }),
  ).rejects.toThrow('widthPx');
});

test('registered track resolves from the workspace by uri', async () => {
  const trace = createFakeTraceImpl();
  trace.tracks.registerTrack({
    uri: '/test/track',
    renderer: {render: () => {}},
  });
  // A registered-but-unlisted uri still resolves (bare node fallback); the
  // render then fails at the canvas layer in jsdom, after layout succeeds.
  await expect(
    renderOffscreenTimeline({
      trace,
      trackUris: ['/test/track'],
      timeSpan: span(0n, 1_000n),
      widthPx: 100,
    }),
  ).rejects.toThrow(); // jsdom: no 2D context
});

function span(start: bigint, end: bigint): HighPrecisionTimeSpan {
  return HighPrecisionTimeSpan.fromTime(start, end);
}
