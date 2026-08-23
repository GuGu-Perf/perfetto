# Exporting a Timeline Image

This guide shows you how to render a Perfetto timeline as a standalone image
(a PNG or JPEG) programmatically — without screenshots, without driving the
UI with an automation tool, and with a guarantee about what the image
contains. This is the right approach when you want to embed timeline
visuals in a report, a bug tracker comment, a regression dashboard, or an
automated analysis pipeline.

The image is rendered **offscreen**: it is a fresh composition of the
requested tracks and time span, produced by the same rendering code the
interactive timeline uses. It never contains page chrome — no sidebar, no
omnibox, no dialogs — so "hide the UI before capturing" is not something you
need to do (or can get wrong).

For the full message and field reference, see
[Embedding API](/docs/visualization/embedding-api-reference.md). For setting
up an embedded iframe in the first place, see
[Embedding the UI](/docs/visualization/embedding-the-ui.md); the steps below
assume that setup.

## Before you begin

- Serve your host page over `http(s)` and complete the PING/PONG handshake
  described in [Embedding the UI](/docs/visualization/embedding-the-ui.md).
- Load a trace first (or in the same session — see step 2).
- Know which tracks and time span you want. The most useful images name
  their subjects: "the RenderThread and sf tracks during the jank at
  t=3428.2s", not "the whole trace".

## Step 1: Request the image

Post a `renderTimelineImage` message to the iframe. The minimal form —
default track set, current visible window, 1920px wide PNG — is:

```js
const reqId = 'img-1';
iframe.contentWindow.postMessage(
    {perfetto: {action: 'renderTimelineImage', id: reqId}}, '*');
```

You do not need to wait for the trace to load before sending this: requests
are queued for up to 60s while the trace arrives, and rendering itself waits
for the workspace to finish building. Post the trace and the image request
back-to-back and both succeed.

## Step 2: Pick the tracks and the time span

A default snapshot of everything is rarely what a report needs. Two mutually
supporting selectors are available:

- `trackUris`: exact workspace URIs, ordered top-to-bottom.
- `trackNames`: human-readable names with optional `tid`/`pid`, e.g.
  `{name: 'RenderThread', tid: 4543}`. Resolved URIs are appended to
  `trackUris`; unmatched names produce a `TRACK_MISSING` warning on the
  result rather than an error.

`pinTracks` moves chosen tracks (which must be part of the rendered set) to
the top of the image — the "pin to top" workflow from the interactive UI.
`timeSpan` is `{start, end}` in nanoseconds, passed as strings so it
survives JSON serialization.

The classic jank-report recipe:

```js
iframe.contentWindow.postMessage(
    {
      perfetto: {
        action: 'renderTimelineImage',
        id: 'jank-1',
        options: {
          trackUris: ['/sched_cpu0', '/cpu_freq_cpu0'],
          trackNames: [{name: 'RenderThread', tid: 4543}, {name: 'sf'}],
          pinTracks: ['/sched_cpu0'],
          timeSpan: {start: '3428202643641', end: '3428410622726'},
          aspectRatio: 4 / 3,
        },
      },
    },
    '*');
```

Width can be given directly (`widthPx`) or derived from the track set's
height via `aspectRatio` — the two are mutually exclusive. Height is always
derived from the tracks: the image is exactly as tall as the requested track
stack.

## Step 3: Receive the result

The reply arrives as a message with a matching `id`:

```js
window.addEventListener('message', (ev) => {
  const d = ev.data?.perfetto;
  if (d?.action !== 'renderTimelineImageResult' || d.id !== 'jank-1') return;
  if (d.error) { /* render failed */ return; }

  const blob = new Blob([d.png], {type: 'image/png'});
  // e.g. attach to the bug report, POST to the dashboard, ...
});
```

`d.png` is an `ArrayBuffer` of encoded image bytes; `d.result` carries
metadata: dimensions, effective `devicePixelRatio`, per-track bounding boxes
(`trackBoxes`, useful for overlaying annotations or building image maps),
`warnings`, and phase timings (`perf`).

## What the image contains

- The track shell column (names, indentation) and the time axis, matching
  the interactive timeline's look. Both can be turned off
  (`includeTrackShell: false`, `includeTimeAxis: false`).
- Only timeline content. Page chrome, interaction state (hover, selection)
  and overlays are structurally excluded, not hidden.
- Data fetched at the canvas's resolution, bounded per track
  (`perTrackTimeoutMs`, default 5s). Tracks that do not settle in time are
  drawn as-is and reported via a `TIMEOUT` warning.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `TRUNCATED` warning | The default (no `trackUris`/`trackNames`) composition exceeded the 2160px height cap. Request an explicit track set. |
| `TRACK_MISSING` warning | A `trackNames` entry matched nothing. Check the exact name and `tid`/`pid`. |
| `TRACK_NOT_RENDERED` warning | A `pinTracks` entry is not part of the rendered set. Add it to `trackUris`/`trackNames` too. |
| `TIMELINE_UNAVAILABLE` warning | The timeline plugin did not register a renderer (no trace loaded, or load failed). |
| `error: 'render queue full'` | More than 32 requests queued while one was running. Render less concurrently. |
