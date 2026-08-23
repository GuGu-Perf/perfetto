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

test('renderTimelineImage rejects when no renderer is registered', async () => {
  const manager = new TimelineImageManagerImpl();
  await expect(manager.renderTimelineImage()).rejects.toThrow(
    /no timeline renderer registered/i,
  );
});

test('manager maps timed out tracks to a TIMEOUT warning', async () => {
  const manager = new TimelineImageManagerImpl();
  const canvas = {
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'])),
  } as unknown as HTMLCanvasElement;
  manager.registerRenderer(async () => ({
    canvas,
    width: 10,
    height: 10,
    trackBoxes: [{uri: '/t', name: 'T', top: 0, height: 10, depth: 0}],
    timedOutTracks: ['/t'],
  }));
  const result = await manager.renderTimelineImage();
  expect(result.warnings).toEqual(['TIMEOUT']);
  expect(result.width).toBe(10);
  expect(result.trackBoxes[0].uri).toBe('/t');
});

test('manager rejects when encoding fails', async () => {
  const manager = new TimelineImageManagerImpl();
  const canvas = {
    toBlob: (cb: (b: Blob | null) => void) => cb(null),
  } as unknown as HTMLCanvasElement;
  manager.registerRenderer(async () => ({
    canvas,
    width: 10,
    height: 10,
    trackBoxes: [],
    timedOutTracks: [],
  }));
  await expect(manager.renderTimelineImage()).rejects.toThrow(/encoding/i);
});
