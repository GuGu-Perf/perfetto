// Generates a small, deterministic, Apache-licensed synthetic trace for the
// timeline-image tests (upstream CI has no AGPL fixtures). Chrome Trace
// Event JSON: TraceProcessor's native input. Content is fully scripted:
// two threads with a known anchor slice + a frequency counter.
import {writeFileSync} from 'fs';
const events = [];
const push = (e) => events.push(e);
push({ph: 'M', name: 'process_name', pid: 1, ts: 0, args: {name: 'com.example.app'}});
push({ph: 'M', name: 'thread_name', pid: 1, tid: 4543, ts: 0, args: {name: 'RenderThread'}});
push({ph: 'M', name: 'thread_name', pid: 1, tid: 100, ts: 0, args: {name: 'main'}});
let t = 1_000_000, n = 0;
while (t < 3_000_000) {
  const dur = 4_000 + (n % 5) * 1_500;
  push({ph: 'X', name: `Choreographer#doFrame ${1000 + n}`, cat: 'gfx', pid: 1, tid: 4543, ts: t, dur});
  t += dur + 6_000; n++;
}
push({ph: 'X', name: 'DrawFrames 1000', cat: 'gfx,timeline-image-anchor', pid: 1, tid: 4543, ts: 1_500_000, dur: 120_000});
push({ph: 'X', name: 'DrawFrames 1001', cat: 'gfx,timeline-image-anchor', pid: 1, tid: 4543, ts: 1_750_000, dur: 60_000});
for (let i = 0; i < 40; i++) {
  push({ph: 'X', name: `Measure#${i}`, cat: 'app', pid: 1, tid: 100, ts: 1_000_000 + i * 48_000, dur: 3_000 + (i % 7) * 900});
}
for (let ts = 1_000_000; ts <= 3_000_000; ts += 20_000) {
  const v = 300_000 + 600_000 * (0.5 + 0.5 * Math.sin(ts / 300_000));
  push({ph: 'C', name: 'cpu_frequency', cat: 'power', pid: 1, ts, args: {value: Math.round(v)}});
}
writeFileSync('test/data/timeline_image_synth.json', JSON.stringify({traceEvents: events}));
console.log(`synthetic trace: ${events.length} events -> test/data/timeline_image_synth.json`);
