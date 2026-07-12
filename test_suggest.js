// Auto-suggest (compiler mode 4) tests — runs against the REAL pure helpers extracted from app.js.
// No private data. Usage: node test_suggest.js
// Covers the discovery spine: sgCentroid (unit-sphere mean) + sgKmeans (spherical, deterministic) +
// sgTokens/sgTopTerms (TF-IDF cluster labels). The async semSuggest wiring is verified live, not here.
/* no 'use strict' — direct eval must define the extracted functions in this scope */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
function extract(name, until) {
  const s = src.indexOf('function ' + name), e = src.indexOf('function ' + until);
  if (s < 0 || e < 0 || e <= s) throw new Error('cannot extract ' + name + '..' + until);
  return src.slice(s, e);
}
// the only global the pure helpers lean on: the stopword map (real one lives elsewhere in app.js)
var MS_STOP = { the: 1, and: 1, for: 1, with: 1, how: 1, this: 1, that: 1, session: 1, resume: 1 };
// v1.44.1: semLensThin/semLensFloor read the ACTIVE model's GATE — shim both calibrations here
var SEM = { GATE: { thinBest: 0.85, thinDelta: 0.10, scopeFloor: 0.76, lensFloor: 0.75, seedFloor: 0.80, coherence: 0.62 } };
var GEMMA_GATE = { thinBest: 0.48, thinDelta: 0.45, scopeFloor: 0.35, lensFloor: 0.45, seedFloor: 0.40, coherence: 0.70 };
// sgRand..semSuggest = sgRand, sgDot, sgCentroid, sgKmeans, sgTokens, sgTopTerms (all pure)
eval(extract('sgRand', 'semSuggest'));

let n = 0, failed = 0;
function ok(label, cond) { n++; if (!cond) { failed++; console.error('FAIL ' + label); } }
function near(label, a, b, eps) { ok(label + ' (' + a + '≈' + b + ')', Math.abs(a - b) <= (eps || 1e-6)); }

const D = 8;
function unit(arr) {
  var v = Float32Array.from(arr), nrm = 0;
  for (var k = 0; k < D; k++) nrm += v[k] * v[k];
  nrm = Math.sqrt(nrm) || 1;
  for (k = 0; k < D; k++) v[k] /= nrm;
  return v;
}
// three well-separated synthetic clusters around basis directions e0,e1,e2 with tiny deterministic noise
function makeVec(c, j) {
  var a = new Array(D).fill(0);
  a[c] = 1;
  for (var k = 0; k < D; k++) if (k !== c) a[k] = 0.06 * (((j * 7 + k * 3) % 5) - 2) / 2; // ≤0.06 noise
  return unit(a);
}

// --- sgDot / sgCentroid ---
ok('sgDot orthonormal = 0', Math.abs(sgDot(unit([1,0,0,0,0,0,0,0]), unit([0,1,0,0,0,0,0,0]), D)) < 1e-9);
ok('sgDot identical = 1', Math.abs(sgDot(unit([1,1,0,0,0,0,0,0]), unit([1,1,0,0,0,0,0,0]), D) - 1) < 1e-6);
(function () {
  var cen = sgCentroid([unit([1,0,0,0,0,0,0,0]), unit([1,0.2,0,0,0,0,0,0])], D);
  var nrm = 0; for (var k = 0; k < D; k++) nrm += cen[k] * cen[k];
  near('sgCentroid is a unit vector', Math.sqrt(nrm), 1, 1e-5);
  ok('sgCentroid points the shared way (dim0 dominant)', cen[0] > 0.9);
})();

// --- sgKmeans: recovers three clusters, purely and deterministically ---
var pts = [], truth = [];
for (var c = 0; c < 3; c++) for (var j = 0; j < 8; j++) { pts.push(makeVec(c, j)); truth.push(c); }
var km = sgKmeans(pts, 3, 14, D, sgRand(1));
ok('sgKmeans returns 3 centroids', km.cent.length === 3);
ok('sgKmeans assign covers all points', km.assign.length === pts.length);
// purity: every point of a true cluster shares ONE assigned id, and the three ids are distinct
var lbl = {};
for (var t = 0; t < 3; t++) {
  var ids = {};
  for (var i = 0; i < truth.length; i++) if (truth[i] === t) ids[km.assign[i]] = 1;
  var keys = Object.keys(ids);
  ok('true cluster ' + t + ' maps to a single k-means cluster', keys.length === 1);
  lbl[keys[0]] = (lbl[keys[0]] || 0) + 1;
}
ok('the three true clusters map to three DISTINCT k-means clusters', Object.keys(lbl).length === 3);
// counts + coherence sanity
var sum = km.count.reduce(function (a, b) { return a + b; }, 0);
ok('counts sum to N', sum === pts.length);
ok('each populated cluster is tight (coherence > 0.9)', km.cohere.every(function (v, ix) { return km.count[ix] === 0 || v > 0.9; }));
// determinism: same seed → identical assignment
var km2 = sgKmeans(pts, 3, 14, D, sgRand(1));
ok('sgKmeans deterministic for a fixed seed', km.assign.join(',') === km2.assign.join(','));
// k is clamped to N when asked for more clusters than points
var kmSmall = sgKmeans([makeVec(0, 0), makeVec(1, 0)], 9, 14, D, sgRand(1));
ok('sgKmeans clamps k to the point count', kmSmall.cent.length === 2);

// --- sgTokens: content terms only ---
var toks = sgTokens('How to deploy Nginx — the SSL session');
ok('sgTokens lowercases + keeps content words', toks.indexOf('deploy') >= 0 && toks.indexOf('nginx') >= 0 && toks.indexOf('ssl') >= 0);
ok('sgTokens drops stopwords', toks.indexOf('the') < 0 && toks.indexOf('how') < 0 && toks.indexOf('session') < 0);
ok('sgTokens drops <3-char tokens', sgTokens('a bc def').join(',') === 'def');
ok('sgTokens dedupes within a title', sgTokens('nginx nginx ssl').filter(function (w) { return w === 'nginx'; }).length === 1);

// --- sgTopTerms: distinctive terms win via TF-IDF, ubiquitous terms lose ---
(function () {
  var N = 40;
  // 'project' is everywhere (df high) → must NOT win even though it's frequent in the cluster
  var df = { project: 38, nginx: 6, certbot: 4, ssl: 5, deploy: 9, pricing: 7, tier: 5 };
  var titles = ['project nginx deploy', 'project certbot ssl', 'nginx ssl renew project', 'project deploy nginx'];
  var terms = sgTopTerms(titles, df, N, 4);
  ok('sgTopTerms surfaces the distinctive term (nginx)', terms[0] === 'nginx');
  ok('sgTopTerms suppresses the ubiquitous term (project)', terms.indexOf('project') < 0);
  ok('sgTopTerms respects the top-N cap', sgTopTerms(titles, df, N, 2).length <= 2);
  ok('sgTopTerms returns [] for empty input', sgTopTerms([], df, N, 4).length === 0);
})();

// --- audit-cycle-2 fixes 1–3: the new pure helpers ---
// fix 1: thin-lens gate (calibrated: real ≥0.85 best OR Δ≥0.10; both-low = thin)
ok('semLensThin: nonsense (0.825/0.746) is thin', semLensThin(0.825, 0.746) === true);
ok('semLensThin: broad preset (0.876/0.815, Δ.061) passes via best', semLensThin(0.876, 0.815) === false);
ok('semLensThin: narrow spike (0.912/0.772, Δ.139) passes via Δ', semLensThin(0.912, 0.772) === false);
ok('semLensThin: both-just-under (0.849/0.750) is thin', semLensThin(0.849, 0.750) === true);
// fix 1b: adaptive floor = max(0.76, median + Δ/2)
near('semLensFloor midpoint', semLensFloor(0.88, 0.80), 0.84, 1e-9);
near('semLensFloor never below 0.76', semLensFloor(0.77, 0.70), 0.76, 1e-9);

// v1.44.1 — the SAME functions under the gemma GATE (numbers from the s14 calibration table)
var E5_GATE = SEM.GATE; SEM.GATE = GEMMA_GATE;
ok('gemma thin: nonsense (0.423/0.206) aborts', semLensThin(0.423, 0.206) === true);
ok('gemma thin: beekeeping (0.440/0.172) aborts', semLensThin(0.440, 0.172) === true);
ok('gemma thin: weakest real seed (0.502/0.212) passes via best', semLensThin(0.502, 0.212) === false);
ok('gemma thin: narrow spike (0.725/0.256, d.469) passes', semLensThin(0.725, 0.256) === false);
near('gemma floor midpoint (wine 0.583/0.197)', semLensFloor(0.583, 0.197), 0.39, 1e-9);
near('gemma floor never below 0.35', semLensFloor(0.36, 0.30), 0.35, 1e-9);
SEM.GATE = E5_GATE;
ok('e5 gate restored (byte-identical e5 behavior)', semLensThin(0.849, 0.750) === true);
// fix 2: sgMaxNN = the seed library's own cone width
(function () {
  var e0 = unit([1,0,0,0,0,0,0,0]), e1 = unit([0,1,0,0,0,0,0,0]);
  ok('sgMaxNN orthogonal set ≈ 0', Math.abs(sgMaxNN([e0, e1], D)) < 1e-9);
  ok('sgMaxNN finds the tight pair', sgMaxNN([e0, e1, unit([1,0.1,0,0,0,0,0,0])], D) > 0.97);
})();
// fix 2: sgTopTerms stem-dedupe — "resume · resuming" can't waste two label slots
(function () {
  var df = { resume: 8, resuming: 7, widget: 5, deploy: 6 };
  var titles = ['resume widget resuming', 'resuming widget resume', 'resume deploy widget', 'resuming resume widget'];
  var terms = sgTopTerms(titles, df, 40, 4);
  var both = terms.indexOf('resume') >= 0 && terms.indexOf('resuming') >= 0;
  ok('sgTopTerms stem-dedupes resume/resuming', !both);
  ok('sgTopTerms still surfaces the distinct terms', terms.indexOf('widget') >= 0);
})();
// fix 3: honest counts
ok('sgApprox exact under 20', sgApprox(7) === '7' && sgApprox(19) === '19');
ok('sgApprox rounds tens', sgApprox(229) === '≈230' && sgApprox(23) === '≈20');
ok('sgApprox rounds hundreds ≥1000', sgApprox(5805) === '≈5800');

console.log('\ntest_suggest: ' + n + ' checks, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
