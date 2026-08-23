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

import {TimelineImageManagerImpl} from './timeline_image_manager';
import type {TimelineImageOptions} from '../public/timeline_image';

const OPTS: TimelineImageOptions = {trackUris: ['/t']};

function fakeCanvas(
  blob: Blob | null,
): {toBlob: (cb: (b: Blob | null) => void) => void} {
  return {toBlob: (cb: (b: Blob | null) => void) => cb(blob)};
}

test('renderTimelineImage rejects when no renderer is registered', async () => {
  const manager = new TimelineImageManagerImpl();
  await expect(manager.renderTimelineImage(OPTS)).rejects.toThrow(
    /no timeline renderer registered/i,
  );
});

test('manager maps timed out tracks to a TIMEOUT warning', async () => {
  const manager = new TimelineImageManagerImpl();
  const canvas = fakeCanvas(new Blob(['x'])) as unknown as HTMLCanvasElement;
  manager.registerRenderer(async () => ({
    canvas,
    width: 10,
    height: 10,
    trackBoxes: [{uri: '/t', name: 'T', top: 0, height: 10, depth: 0}],
    timedOutTracks: ['/t'],
    warnings: [],
  }));
  const result = await manager.renderTimelineImage(OPTS);
  expect(result.warnings).toEqual(['TIMEOUT']);
  expect(result.width).toBe(10);
  expect(result.trackBoxes[0].uri).toBe('/t');
});

test('manager rejects when encoding fails', async () => {
  const manager = new TimelineImageManagerImpl();
  const canvas = fakeCanvas(null) as unknown as HTMLCanvasElement;
  manager.registerRenderer(async () => ({
    canvas,
    width: 10,
    height: 10,
    trackBoxes: [],
    timedOutTracks: [],
    warnings: [],
  }));
  await expect(manager.renderTimelineImage(OPTS)).rejects.toThrow(/encoding/i);
});

test('manager serializes concurrent renders (shared-canvas safety)', async () => {
  const manager = new TimelineImageManagerImpl();
  const canvas = fakeCanvas(new Blob(['x'])) as unknown as HTMLCanvasElement;
  const events: string[] = [];
  let running = false;
  manager.registerRenderer(async () => {
    // Detect overlap the way the real renderer would break: two renders
    // painting through the same surfaces at once.
    if (running) events.push('OVERLAP');
    running = true;
    await new Promise((r) => setTimeout(r, 10));
    running = false;
    events.push('done');
    return {
      canvas,
      width: 10,
      height: 10,
      trackBoxes: [],
      timedOutTracks: [],
      warnings: [],
    };
  });
  await Promise.all([
    manager.renderTimelineImage(OPTS),
    manager.renderTimelineImage(OPTS),
    manager.renderTimelineImage(OPTS),
  ]);
  expect(events).toEqual(['done', 'done', 'done']);
});

test('a failed render does not block later renders', async () => {
  const manager = new TimelineImageManagerImpl();
  const canvas = fakeCanvas(new Blob(['x'])) as unknown as HTMLCanvasElement;
  let calls = 0;
  manager.registerRenderer(async () => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return {
      canvas,
      width: 10,
      height: 10,
      trackBoxes: [],
      timedOutTracks: [],
      warnings: [],
    };
  });
  await expect(manager.renderTimelineImage(OPTS)).rejects.toThrow('boom');
  const ok = await manager.renderTimelineImage(OPTS);
  expect(ok.width).toBe(10);
});
