// T1.13: retention policy for out/test-runs (plan D.4):
// keep at most 50 run directories, at most 30 days old, at most 2GB total;
// oldest first. LATEST symlinks and overlay-immunity evidence are pinned.
import {readdirSync, statSync, unlinkSync, rmdirSync} from 'fs';
import {join} from 'path';

const ROOT = new URL('../../', import.meta.url).pathname;
const DIR = ROOT + 'out/test-runs';
const MAX_RUNS = 50;
const MAX_AGE_DAYS = 30;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const PINNED = ['LATEST.png', 'LATEST.json', '20260823-overlay-immunity'];

const entries = readdirSync(DIR, {withFileTypes: true})
  .filter((e) => !e.name.startsWith('.') && !PINNED.includes(e.name) && !e.name.startsWith('native-tp'));
// Loose files (screenshots/logs from ad-hoc probes) simply age out.
for (const e of entries) {
  if (!e.isDirectory() && statSync(join(DIR, e.name)).mtimeMs < Date.now() - MAX_AGE_DAYS * 86400_000) {
    unlinkSync(join(DIR, e.name));
  }
}
const runs = entries
  .filter((e) => e.isDirectory())
  .map((e) => ({name: e.name, path: join(DIR, e.name), mtimeMs: statSync(join(DIR, e.name)).mtimeMs}))
  .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

const rm = (p) => {
  for (const e of readdirSync(p, {withFileTypes: true})) {
    if (e.isDirectory()) rm(join(p, e.name));
    else unlinkSync(join(p, e.name));
  }
  rmdirSync(p);
};

const sizeOf = (p) => {
  let total = 0;
  for (const e of readdirSync(p, {withFileTypes: true})) {
    total += e.isDirectory() ? sizeOf(join(p, e.name)) : statSync(join(p, e.name)).size;
  }
  return total;
};

let total = runs.reduce((acc, r) => acc + sizeOf(r.path), 0);
const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
let removed = 0;
while (runs.length > 0) {
  const oldest = runs[0];
  const overCount = runs.length > MAX_RUNS;
  const overAge = oldest.mtimeMs < cutoff;
  const overSize = total > MAX_TOTAL_BYTES;
  if (!overCount && !overAge && !overSize) break;
  total -= sizeOf(oldest.path);
  rm(oldest.path);
  runs.shift();
  removed++;
}
console.log(`prune: ${removed} removed, ${runs.length} kept, ${(total / 1e6).toFixed(1)}MB total`);
