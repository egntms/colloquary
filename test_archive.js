// Whole-archive export/import round-trip tests — runs against the REAL functions:
//   buildArchive     (app.js)    — wraps convs in the native {skillmint_archive,schema,convs} payload
//   isNativeArchive  (worker.js) — detects that payload on drop so records upsert without re-normalization
// No private data needed. Usage: node test_archive.js
// Guards: marker/schema/count shape, detection precision (raw Claude export array must NOT match),
// and a JSON round-trip preserving every conv field (source/project/attachment ty+fn/per-conv schema).
/* no 'use strict' — direct eval must be able to define the extracted functions in this scope */
const fs = require('fs');

const appSrc = fs.readFileSync(__dirname + '/app.js', 'utf8');
const wrkSrc = fs.readFileSync(__dirname + '/worker.js', 'utf8');
function slice(src, name, until) {
  const start = src.indexOf('function ' + name);
  const end = src.indexOf('function ' + until, start + 1);
  if (start < 0 || end < 0 || end <= start) throw new Error('cannot extract ' + name);
  return src.slice(start, end);
}
eval(slice(appSrc, 'buildArchive', 'downloadArchive'));
eval(slice(wrkSrc, 'isNativeArchive', 'isoFromMs'));

let n = 0, failed = 0;
function ok(label, cond) { n++; if (!cond) { failed++; console.error('FAIL ' + label); } }

// synthetic archive: one plain Claude conv, one Code session, one Cowork session with an attachment doc
const convs = [
  { uuid: 'a', name: 'Claude chat', created_at: '2026-04-01T08:00', updated_at: '2026-04-01T08:30', schema: 3,
    fileNames: ['x.txt'], docs: [ { s: 'h', d: '2026-04-01T08:00', t: 'hi' }, { s: 'a', d: '2026-04-01T08:01', t: 'hello' } ] },
  { uuid: 'b', name: 'fits: fix build', created_at: '2026-05-02T10:00', updated_at: '2026-05-02T11:00', schema: 3,
    source: 'code', project: 'fits', fileNames: [], docs: [ { s: 'h', d: '2026-05-02T10:00', t: 'build broke' } ] },
  { uuid: 'c', name: 'Cowork meal planner', created_at: '2026-06-10T12:00', updated_at: '2026-06-10T13:00', schema: 3,
    source: 'cowork', project: 'meals', fileNames: ['plan.md'],
    docs: [ { s: 'h', d: '2026-06-10T12:00', t: 'plan meals' }, { s: 'a', d: '2026-06-10T12:01', ty: 'a', fn: 'plan.md', t: 'Mon: lentils' } ] }
];

// ---- payload shape ----
const payload = buildArchive(convs, 3);
ok('marker present', payload.skillmint_archive === true);
ok('schema carried', payload.schema === 3);
ok('count matches convs length', payload.count === 3 && payload.count === payload.convs.length);
ok('exportedAt is ISO', typeof payload.exportedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(payload.exportedAt));
ok('convs carried through', Array.isArray(payload.convs) && payload.convs.length === 3);

// ---- detection precision (must not misfire on other inputs the worker can see) ----
ok('detects the native payload', isNativeArchive(payload) === true);
ok('raw Claude export array is NOT native', isNativeArchive(convs) === false);
ok('marker without convs is NOT native', isNativeArchive({ skillmint_archive: true }) === false);
ok('convs without marker is NOT native', isNativeArchive({ convs: [] }) === false);
ok('null is NOT native', isNativeArchive(null) === false);
ok('truthy-but-not-true marker is NOT native', isNativeArchive({ skillmint_archive: 1, convs: [] }) === false);

// ---- JSON round-trip (the real transport: stringify -> zip -> unzip -> parse) ----
const round = JSON.parse(JSON.stringify(payload));
ok('round-trip still native', isNativeArchive(round) === true);
ok('round-trip preserves conv count', round.convs.length === convs.length);
ok('round-trip deep-equals convs (nothing lost/reordered)', JSON.stringify(round.convs) === JSON.stringify(convs));
ok('round-trip keeps source + project', round.convs[1].source === 'code' && round.convs[1].project === 'fits');
ok('round-trip keeps attachment doc ty + fn', round.convs[2].docs[1].ty === 'a' && round.convs[2].docs[1].fn === 'plan.md');
ok('round-trip keeps per-conv schema', round.convs.every(function (c) { return c.schema === 3; }));

// ---- empty archive (the button guards this, but the builder must not crash) ----
const empty = buildArchive([], 3);
ok('empty archive is still native-shaped', isNativeArchive(empty) === true && empty.count === 0);

// ---- v1.27.0: sample-archive dataset (C5) must be valid, clearly-fake conv records ----
var SCHEMA = 3; /* demoConvs stamps records with the app SCHEMA */
eval(slice(appSrc, 'demoConvs', 'removeDemo'));
const demo = demoConvs();
ok('demo: 8 records', demo.length === 8);
ok('demo: every uuid is demo-*', demo.every(function (c) { return c.uuid.indexOf('demo-') === 0; }));
ok('demo: every name clearly fake', demo.every(function (c) { return /^Sample/.test(c.name); }));
const srcs = {}; demo.forEach(function (c) { srcs[c.source || 'claude'] = 1; });
ok('demo: all five sources present', srcs.claude && srcs.chatgpt && srcs.cowork && srcs.code && srcs.project, JSON.stringify(srcs));
ok('demo: docs well-formed', demo.every(function (c) {
  return c.schema === 3 && c.docs.length && c.docs.every(function (d) {
    return (d.s === 'h' || d.s === 'a') && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.d) && d.t.length > 0 && (d.ty !== 'a' || d.fn);
  });
}));
ok('demo: has openable attachments AND name-only files', demo.some(function (c) {
  return c.docs.some(function (d) { return d.ty === 'a'; });
}) && demo.some(function (c) {
  var withDoc = {}; c.docs.forEach(function (d) { if (d.ty === 'a') withDoc[d.fn] = 1; });
  return (c.fileNames || []).some(function (fn) { return !withDoc[fn]; });
}));
const demoArch = buildArchive(demo, 3);
ok('demo: survives the archive round-trip', isNativeArchive(JSON.parse(JSON.stringify(demoArch))) && JSON.parse(JSON.stringify(demoArch)).convs.length === 8);

if (failed) { console.error(failed + ' of ' + n + ' checks failed'); process.exit(1); }
console.log('ALL ' + n + ' archive checks passed');
