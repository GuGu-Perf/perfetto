// Lightweight-CI replacement for the gn/ninja steps of ui/build.mjs. Produces
// the ui/src/gen artifacts that tsc and vitest import, without the buildtools
// (emsdk / C++ toolchain) install:
//   - protos.js / protos.d.ts: real protobufjs output (pbjs + pbts from the
//     protobufjs-cli dev dependency). Byte-identical to the full build's.
//   - {traceconv, proto_utils, trace_processor, trace_processor_memory64}:
//     emscripten modules built by ninja in full builds. The unit suite never
//     instantiates them, so the .js is a stub that throws if called; the
//     .d.ts (ci/wasm_module.d.ts, identical for all four) is checked in.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const UI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_DIR = path.dirname(UI_DIR);
const GEN_DIR = path.join(UI_DIR, 'src/gen');

const PROTO_INPUTS = [
  'protos/perfetto/ipc/consumer_port.proto',
  'protos/perfetto/ipc/wire_protocol.proto',
  'protos/perfetto/trace/perfetto/perfetto_metatrace.proto',
  'protos/perfetto/perfetto_sql/structured_query.proto',
  'protos/perfetto/trace_processor/trace_processor.proto',
];

fs.rmSync(GEN_DIR, {recursive: true, force: true});
fs.mkdirSync(GEN_DIR, {recursive: true});

const bin = (name) => path.join(UI_DIR, 'node_modules', '.bin', name);

const protosJs = path.join(GEN_DIR, 'protos.js');
execFileSync(
  bin('pbjs'),
  [
    '--no-beautify',
    '--force-number',
    '--no-delimited',
    '--no-verify',
    '-t',
    'static-module',
    '-w',
    'es6',
    '-p',
    ROOT_DIR,
    '-o',
    protosJs,
  ].concat(PROTO_INPUTS),
  {stdio: 'inherit'},
);

const protosTs = path.join(GEN_DIR, 'protos.d.ts');
execFileSync(bin('pbts'), ['--no-comments', '-p', ROOT_DIR, '-o', protosTs, protosJs], {
  stdio: 'inherit',
});
// Drop the `import Long = require("long")` line pbts emits; see
// postProcessProtosDts() in build.mjs.
let dts = fs.readFileSync(protosTs, 'utf8');
dts = dts.replace(/import Long = require\("long"\);\r?\n/g, '');
fs.writeFileSync(protosTs, dts);

const STUB_JS = (mod) => `// Lightweight-CI stub for the emscripten module ${mod} (built by ninja in
// full builds). Unit tests never instantiate it; they mock the engine.
export default async function ${mod}_wasm() {
  throw new Error('${mod} wasm module is not built in the lightweight CI');
}
`;

for (const mod of ['traceconv', 'proto_utils', 'trace_processor', 'trace_processor_memory64']) {
  fs.copyFileSync(
    path.join(UI_DIR, 'ci', 'wasm_module.d.ts'),
    path.join(GEN_DIR, `${mod}.d.ts`),
  );
  fs.writeFileSync(path.join(GEN_DIR, `${mod}.js`), STUB_JS(mod));
}

console.log('gen artifacts written to', GEN_DIR);
