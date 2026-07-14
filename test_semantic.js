// test_semantic.js — v1.29 semantic search: pure doc-extraction layer (task 3+4 groundwork).
// Runs the REAL semHash/semLooksPaste/semExtractDocs + SEM consts extracted from app.js against
// SYNTHETIC conv records only — no private data. IDB store + embed loop are browser-verified live
// (they need IndexedDB + the model). Run: node test_semantic.js
var fs = require('fs');
var path = require('path');

var appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function slice(from, to) {
  var a = appSrc.indexOf(from), b = appSrc.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error('cannot slice ' + from);
  return appSrc.slice(a, b);
}
eval(slice('var SEM = {', '/* --- vector store')); // SEM + semHash + semLooksPaste + semExtractDocs

var fails = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { fails++; console.log('FAIL: ' + msg); } else console.log('ok:   ' + msg); }

// ---------- SEM consts sanity ----------
ok(SEM.MODEL.indexOf('/vendor/models/') === 0, 'MODEL id carries the webroot path (3.4.0 localModelPath gotcha)');
ok(SEM.MODEL_KEY === 'Xenova/multilingual-e5-small', 'MODEL_KEY is the clean model name (vector-store key)');
ok(SEM.DIMS === 384, 'DIMS 384 (e5-small)');
ok(SEM.QPRE === 'query: ' && SEM.PPRE === 'passage: ', 'e5 asymmetric prefixes');
ok(SEM.BATCH.webgpu <= 16 && SEM.BATCH.wasm <= 8, 'batch sizes conservative (WindowServer crash guard)');
ok(SEM.PASTE_PEN > 0.9 && SEM.PASTE_PEN < 1, 'paste penalty is a mild down-rank, not a filter');

// ---------- semHash ----------
ok(semHash('abc') === semHash('abc'), 'hash deterministic');
ok(semHash('abc') !== semHash('abd'), 'hash distinguishes content');
ok(/:3$/.test(semHash('abc')), 'hash carries length suffix (extra collision guard)');

// ---------- semLooksPaste ----------
var prose = 'I tried to deploy the new version yesterday.\nIt failed on the second step.\nCan you check what is wrong with it?\nThanks a lot for the help.';
var code = 'const x = { a: 1, b: [2, 3] };\nif (x.a >= 1) { console.log(x); }\nfunction f() { return x; }\nmodule.exports = { f };';
var short_ = 'const x = { a: 1 };';
ok(!semLooksPaste(prose), 'prose is not a paste');
ok(semLooksPaste(code), 'code block detected as paste');
ok(!semLooksPaste(short_), '1-2 line snippets never flagged (needs >2 lines)');

// ---------- semExtractDocs ----------
var LONG = 'this message is long enough to be embedded because it clearly has more than thirty characters';
var HUGE = new Array(3000).join('x'); // 2999 chars, no newlines -> not a paste
var convs = [
  { uuid: 'aaa', name: 'Deploy talk', docs: [
    { s: 'h', d: '2026-01-01T10:00', t: 'ok' },                       // < DOC_MIN -> skipped
    { s: 'h', d: '2026-01-01T10:01', t: LONG },                       // message doc
    { s: 'a', d: '2026-01-01T10:02', t: HUGE },                       // capped
    { s: 'h', d: '2026-01-01T10:03', t: LONG + ' shared attachment body', ty: 'a', fn: 'notes.md' }
  ] },
  { uuid: 'bbb', name: '', docs: [
    { s: 'h', d: '2026-01-02T09:00', t: LONG + ' shared attachment body', ty: 'a', fn: 'notes.md' }, // dup content, DIFFERENT conv -> deduped only if title also matches (bbb has no name)
    { s: 'h', d: '2026-01-02T09:01', t: LONG }                        // same text as aaa:1 but different title-prefix -> kept
  ] }
];
var docs = semExtractDocs(convs);
ok(docs.every(function (d) { return d.key.indexOf(SEM.MODEL_KEY + '|') === 0; }), 'every key is MODEL_KEY-prefixed');
ok(docs.every(function (d) { return /^(aaa|bbb):\d+$/.test(d.id); }), 'ids are uuid:i (join key for hybrid RRF)');
ok(!docs.some(function (d) { return d.id === 'aaa:0'; }), 'below-DOC_MIN doc skipped');
var capped = docs.filter(function (d) { return d.id === 'aaa:2'; })[0];
ok(capped && capped.text.length <= SEM.DOC_CAP + 'Deploy talk: '.length, 'long doc capped at DOC_CAP (+title prefix)');
var titled = docs.filter(function (d) { return d.id === 'aaa:1'; })[0];
ok(titled && titled.text.indexOf('Deploy talk: ') === 0, 'title prefix prepended');
var untitled = docs.filter(function (d) { return d.id === 'bbb:1'; })[0];
ok(untitled && untitled.text.indexOf(':') !== 0 && untitled.text.indexOf(LONG) === 0, 'no stray prefix when conv has no name');
ok(titled.key !== untitled.key, 'same text under different titles = different keys (title is part of the embedding)');
var att = docs.filter(function (d) { return d.id === 'aaa:3'; })[0];
ok(att && att.paste === true, 'attachments always carry the paste flag');
ok(!titled.paste, 'plain prose message not flagged as paste');

// dedupe: SAME title + SAME text in two convs -> one entry
var dup = semExtractDocs([
  { uuid: 'c1', name: 'Same', docs: [{ s: 'h', d: '2026-01-01', t: LONG, ty: 'a', fn: 'x.md' }] },
  { uuid: 'c2', name: 'Same', docs: [{ s: 'h', d: '2026-01-02', t: LONG, ty: 'a', fn: 'x.md' }] }
]);
ok(dup.length === 1 && dup[0].id === 'c1:0', 'identical title+content across convs embeds once');

// determinism: same input -> same keys (incremental imports rely on this)
var again = semExtractDocs(convs);
ok(JSON.stringify(docs.map(function (d) { return d.key; })) === JSON.stringify(again.map(function (d) { return d.key; })), 'extraction deterministic (incremental correctness)');

// ---------- semRRF (hybrid re-rank, task 6) ----------
var fused = semRRF([['a', 'b', 'c'], ['c', 'd']]);
ok(Math.abs(fused.a - 1 / 61) < 1e-9, 'rank 1 in one list scores 1/(K+1)');
ok(fused.c > fused.a, 'present in BOTH lists beats a solo #1 (the multi-proper-noun fix)');
ok(Math.abs(fused.b - fused.d) < 1e-9, 'same rank in either list = same contribution (score-scale independence)');
var one = semRRF([['x', 'y']]);
ok(one.x > one.y, 'single list preserves order');
var kBig = semRRF([['a'], ['b']], 1000);
ok(Math.abs(kBig.a - kBig.b) < 1e-9 && kBig.a < fused.a, 'K damps rank differences');

// ---------- v1.44.0 model registry + MRL post-processing ----------
ok(SEM_MODELS.e5 === SEM, 'active model starts as e5 (SEM is the registry pointer)');
ok(SEM.CAL === true, 'e5 is the calibrated model (compile/suggest gates live in its space)');
var G = SEM_MODELS.gemma256;
ok(G.DIMS === 256 && G.NATIVE_DIMS === 768, 'gemma stores MRL-256 slices of native 768d');
ok(G.MODEL.indexOf('/vendor/models/') === 0 && G.LIB.indexOf('/vendor/v4/') === 0, 'gemma assets self-hosted, v4 lib path');
ok(G.MODEL_KEY !== SEM.MODEL_KEY, 'distinct MODEL_KEY = distinct vector-store namespace (e5 vectors survive a switch)');
ok(G.BATCH.webgpu <= 8 && G.BATCH.wasm <= 8, 'gemma batch <=8 (the bench hard guard)');
ok(G.CAL === true, 'gemma calibrated (v1.44.1 — s14/s14b on the real gemma .cvec)');
['thinBest','thinDelta','scopeFloor','lensFloor','seedFloor','coherence'].forEach(function (k) {
  ok(typeof SEM.GATE[k] === 'number' && typeof G.GATE[k] === 'number', 'GATE.' + k + ' present on both models');
});
ok(G.GATE.thinBest < SEM.GATE.thinBest && G.GATE.seedFloor < SEM.GATE.seedFloor, 'gemma gates sit lower (its cosine space is wider, not compressed)');
ok(G.GATE.coherence > SEM.GATE.coherence, 'gemma coherence gate is stricter (0.62 was dead in e5 space)');
ok(/query: $/.test(G.QPRE) && /text: $/.test(G.PPRE), 'gemma prompt-format prefixes');

// semPostVec: plain model (e5) = a COPY, never a view into the runtime's reused buffer
var srcv = new Float32Array(384); srcv[0] = 3; srcv[1] = 4;
var cp = semPostVec(srcv);
ok(cp.length === 384 && cp !== srcv && cp[0] === 3 && cp[1] === 4, 'e5 semPostVec copies, values intact');
// semPostVec: MRL model = truncate to DIMS + renormalize (energy beyond 256 discarded)
SEM = SEM_MODELS.gemma256;
var raw = new Float32Array(768); raw[0] = 3; raw[1] = 4; raw[700] = 99;
var tv = semPostVec(raw);
ok(tv.length === 256, 'MRL vector truncated to 256');
ok(Math.abs(tv[0] - 0.6) < 1e-6 && Math.abs(tv[1] - 0.8) < 1e-6, 'MRL slice renormalized to unit length');
var normSq = 0; for (var ni = 0; ni < 256; ni++) normSq += tv[ni] * tv[ni];
ok(Math.abs(normSq - 1) < 1e-6, 'MRL output is unit-norm (cosine geometry preserved)');
SEM = SEM_MODELS.e5;
ok(semExtractDocs(convs)[0].key.indexOf('Xenova/') === 0, 'restored to e5 -> doc keys back in the e5 namespace');

// ---------- v1.50.0 semImportBuffer: cross-model guard + iOS-followable advice ----------
eval(slice('function cvecHeader', 'function reqPersist')); // v1.52.0: header peek + the .cvec parser, both pure
function cvecBuf(mk, dims, entries) {
  var enc = new TextEncoder(), mkB = enc.encode(mk);
  var size = 4 + 1 + 2 + 2 + mkB.length + 4;
  entries.forEach(function (e) { size += 2 + enc.encode(e[0]).length + dims * 4; });
  var buf = new ArrayBuffer(size), dv = new DataView(buf), u8 = new Uint8Array(buf), o = 0;
  u8[0] = 67; u8[1] = 86; u8[2] = 69; u8[3] = 67; o = 4;
  dv.setUint8(o, 1); o += 1;
  dv.setUint16(o, dims, true); o += 2;
  dv.setUint16(o, mkB.length, true); o += 2;
  u8.set(mkB, o); o += mkB.length;
  dv.setUint32(o, entries.length, true); o += 4;
  entries.forEach(function (e) {
    var kB = enc.encode(e[0]);
    dv.setUint16(o, kB.length, true); o += 2;
    u8.set(kB, o); o += kB.length;
    new Uint8Array(buf, o, dims * 4).set(new Uint8Array(e[1].buffer)); o += dims * 4;
  });
  return buf;
}
var v384 = new Float32Array(384); v384[0] = 0.5; v384[383] = -0.25;
var good = semImportBuffer(cvecBuf(SEM.MODEL_KEY, 384, [['k1', v384]]));
ok(good.length === 1 && good[0][0] === 'k1' && good[0][1][0] === 0.5 && good[0][1][383] === -0.25, 'matching .cvec round-trips float-exact');
var junk = new ArrayBuffer(16);
var junkErr = ''; try { semImportBuffer(junk); } catch (e) { junkErr = e.message; }
ok(/Not a colloquary embeddings/.test(junkErr), 'bad magic rejected by name');
var gBuf = cvecBuf(SEM_MODELS.gemma256.MODEL_KEY, 256, []);
var dErr = ''; try { semImportBuffer(gBuf); } catch (e) { dErr = e.message; }
ok(/Switch the semantic model to /.test(dErr) && dErr.indexOf(SEM_MODELS.gemma256.LABEL) >= 0, 'desktop cross-model error: switch-the-model advice, names gemma');
var iErr = ''; try { semImportBuffer(gBuf, true); } catch (e) { iErr = e.message; }
ok(/On your computer/.test(iErr) && iErr.indexOf(SEM.LABEL) >= 0, 'iOS cross-model error: advice the phone can follow (export an e5 .cvec on the computer)');
ok(!/first \(top bar/.test(iErr), 'iOS error never tells the phone to use the desktop-only switcher');
// ---------- v1.52.0 cvecHeader: the pure header peek behind the phone's model-switch offer ----------
var hd = cvecHeader(cvecBuf(SEM_MODELS.gemma256.MODEL_KEY, 256, []));
ok(hd.mk === SEM_MODELS.gemma256.MODEL_KEY && hd.dims === 256 && hd.count === 0, 'cvecHeader reads mk/dims/count without touching entries');
var hd2 = cvecHeader(cvecBuf(SEM.MODEL_KEY, 384, [['k1', v384]]));
ok(hd2.count === 1 && hd2.o === 4 + 1 + 2 + 2 + new TextEncoder().encode(SEM.MODEL_KEY).length + 4, 'cvecHeader offset lands exactly at the first entry');
var hErr = ''; try { cvecHeader(new ArrayBuffer(16)); } catch (e) { hErr = e.message; }
ok(/Not a colloquary embeddings/.test(hErr), 'cvecHeader rejects bad magic by name');

// --- v1.56.2 (§11 F2 v3): semFoldFilter — KEYWORD-ANCHORED gate (v1 corroboration lost to dense
// convs; v2's rank<10 new-conv channel leaked one straggler — both live-verified by Eugen) ---
function fp(cu) { return { convUuid: cu }; }
function fill(n, pre, from) { return Array.from({ length: n }, function (_, i) { return fp(pre + (from + i)); }); }
// rich keyword (kwCount 100 ≥ 50): precision mode — ≈ enriches kw-matched convs ONLY, no new convs
// ranks: kwA=0 · new0..new9=1..10 · dense×3=11,12,13 · kwB=14
var rp = [fp('kwA')].concat(fill(10, 'new', 0)).concat([fp('dense'), fp('dense'), fp('dense')]).concat([fp('kwB')]);
var rr = semFoldFilter(rp, { kwA: 1, kwB: 1 }, 100);
ok(rr.filter(function (s) { return s.convUuid === 'kwA' || s.convUuid === 'kwB'; }).length === 2, 'fold v3 rich: kw-supported convs fold freely at any rank');
ok(rr.length === 2, 'fold v3 rich: NO new conv folds — even rank 1, even self-corroborating (the straggler case)');
ok(rr[0].convUuid === 'kwA' && rr[1].convUuid === 'kwB', 'fold v3: order preserved');
// sparse keyword (kwCount 10 < 50): recall mode — cap 40 + the ≥2-passage rule
var sp = fill(45, 's', 0).concat([fp('late'), fp('deepPair'), fp('x1'), fp('deepPair')]);
var sr = semFoldFilter(sp, {}, 10);
ok(sr.filter(function (s) { return /^s\d+$/.test(s.convUuid); }).length === 40, 'fold v2 sparse: new convs keep the top-40');
ok(sr.some(function (s) { return s.convUuid === 'late'; }) === false && sr.some(function (s) { return s.convUuid === 'x1'; }) === false, 'fold v2 sparse: deep singletons dropped');
ok(sr.filter(function (s) { return s.convUuid === 'deepPair'; }).length === 2, 'fold v2 sparse: ≥2-passage conv survives beyond the cap');

console.log(checks - fails + '/' + checks + ' semantic checks passed');
if (fails) process.exit(1);
