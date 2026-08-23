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

Post a `renderTimelineImage` message to the iframe. The minimal form is one
track list — everything else has a default (`timeSpan`: the whole trace,
`widthPx`: 1920, `devicePixelRatio`: 2, `format`: PNG):

```js
const reqId = 'img-1';
iframe.contentWindow.postMessage(
    {perfetto: {action: 'renderTimelineImage', id: reqId,
      options: {trackUris: ['/thread_7303']}}}, '*');
```

You do not need to wait for the trace to load before sending this: requests
are queued for up to 60s while the trace arrives, and rendering itself waits
for the workspace to finish building. Post the trace and the image request
back-to-back and both succeed.

## Step 2: Pick the tracks and the time span

A default snapshot of everything is rarely what a report needs. Selection is
inclusion-only, by workspace URI:

- `trackUris`: exact workspace URIs. **The list order is the render order,
  top to bottom** — putting a URI first is how you pin it to the top.
  URI shapes you will use most (spellings of the current built-in plugins;
  the SQL tables are the stable contract):
  - `/thread_<utid>`: every capability track of that thread (CPU state,
    slices, and whatever else the trace provides for it);
  - `/process_<upid>/thread_<utid>_state` (or `/thread_<utid>_state`
    when the thread has no process): exactly the thread's CPU state track;
  - `/slice_<trackId>`: exactly the thread's slice track.
  The ids come from trace_processor, so a caller that knows a thread can
  select precisely, e.g. `select utid, upid from thread where tid = 4543`,
  then the `track`/`thread_track` tables for single capability tracks.
  Unknown URIs reject the render with an error listing them.
- Not sure which URIs the trace has? Ask the UI with a `listTracks`
  message: it returns the live workspace tree (`uri`, `name`, display
  `path`, `isGroup`) — the same rows the interactive UI shows. The batch
  flow is load trace -> `listTracks` -> filter caller-side -> render.

The classic jank-report recipe:

```js
iframe.contentWindow.postMessage(
    {
      perfetto: {
        action: 'renderTimelineImage',
        id: 'jank-1',
        options: {
          // Order = top-to-bottom render order; /thread_<utid> expands to
          // the thread's capability tracks.
          trackUris: ['/sched_cpu0', '/thread_7303', '/cpu_freq_cpu0'],
          timeSpan: {start: '3428202643641', end: '3428410622726'},
          aspectRatio: 4 / 3,
        },
      },
    },
    '*');
```

Image size, with defaults:

- `widthPx`: the width in CSS pixels. Default **1920**. For a target aspect
  ratio instead of a fixed width, render once, read `height` from the
  result (it does not depend on the width), and re-render with
  `widthPx = round(height * ratio)` — the output is identical.
- `heightPx`: optional exact canvas height. The track content has a natural
  height (time axis + track stack); a larger `heightPx` pads the remainder
  with background (fixed-size report grids), a smaller one clips the content
  and reports a `TRUNCATED` warning. Default: the image is exactly as tall
  as the content.

So a fixed 1080x1920 report cell is `{widthPx: 1080, heightPx: 1920}`.
Track names (shell) and the time axis are always drawn — they are part of
what a timeline image is, not options.

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
| `TRUNCATED` warning | `heightPx` is smaller than the track content; the content was clipped. Drop `heightPx` or enlarge it. |
| Render error `trackUris is required` | Selection is explicit — pass `trackUris` (discover URIs with `listTracks`). |
| Render error `unknown track uris` | A URI in `trackUris` matched nothing in the workspace. Check the URI (ids come from trace_processor tables). |
| `TIMELINE_UNAVAILABLE` warning | The timeline plugin did not register a renderer (no trace loaded, or load failed). |
| `error: 'render queue full'` | More than 32 requests queued while one was running. Render less concurrently. |
