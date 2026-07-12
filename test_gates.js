// test_gates.js — adaptive-gate validation for buildProfilePack (me.skill universal, backlog §11a)
// Runs the REAL functions extracted from app.js against samples/ (gitignored, real Cowork sessions)
// plus synthetic archives (terse texter / verbose writer) to prove gates scale and clamp.
// No private data printed — only counts and gate values. Run: node test_gates.js
var fs = require('fs');
var path = require('path');

var self = {};
eval(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8'));

var appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function slice(from, to) {
  var a = appSrc.indexOf(from), b = appSrc.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error('cannot slice ' + from);
  return appSrc.slice(a, b);
}
eval(slice('function fold(s)', 'function esc('));                 // fold
eval(slice('var MS_STOP', 'function renderMeSkill'));             // MS_* + ms* + pv* + msGates + buildProfilePack

var state = { convs: [] };

var fails = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { fails++; console.log('FAIL: ' + msg); } else console.log('ok:   ' + msg); }

// ---------- 1. real samples ----------
var dir = path.join(__dirname, 'samples');
if (fs.existsSync(dir)) {
  fs.readdirSync(dir).filter(function (f) { return /^main_.*\.jsonl$/.test(f); }).forEach(function (f) {
    var metaFile = path.join(dir, f.replace('.jsonl', '.meta.json'));
    var meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
    var uuid = meta ? String(meta.cliSessionId).toLowerCase() : f;
    var conv = normalizeSession(fs.readFileSync(path.join(dir, f), 'utf8'), meta, uuid, '.claude/projects/-Users-eugen-x/' + uuid + '.jsonl');
    if (conv) state.convs.push(conv);
  });
  var p = buildProfilePack();
  var G = p.gates;
  console.log('samples: ' + p.convs + ' convs, ' + p.authored + ' authored · gates ' + JSON.stringify(G));
  ok(G.medianChars > 0 && G.medianWords > 0, 'medians computed from real samples');
  ok(G.critWords >= 12 && G.critWords <= 40, 'critWords in clamp range (' + G.critWords + ')');
  ok(G.pickWords >= 10 && G.pickWords <= 30, 'pickWords in clamp range (' + G.pickWords + ')');
  ok(G.accWords >= 5 && G.accWords <= 16, 'accWords in clamp range (' + G.accWords + ')');
  ok(G.corrChars >= 120 && G.corrChars <= 400, 'corrChars in clamp range (' + G.corrChars + ')');
  ok(p.critiques.length + p.decisions.length + p.acceptance.length + p.bareApprovals > 0,
     'pivot extractors still produce output (' + p.critiques.length + ' crit, ' + p.decisions.length + ' dec, ' +
     p.acceptance.length + ' acc, ' + p.bareApprovals + ' bare)');
} else console.log('samples/ not found — skipping real-sample block');

// ---------- 2. synthetic archives: gates must SCALE ----------
function mkConv(uuid, msgs) {
  return { uuid: uuid, name: 'synth ' + uuid, created_at: '2026-01-01', updated_at: '2026-01-02',
           msgCount: msgs.length, schema: 3, fileNames: [],
           docs: msgs.map(function (m, i) { return { s: m[0], d: '2026-01-01T10:' + String(10 + i).slice(-2), t: m[1] }; }) };
}
var terseMsg = 'fix the bug now ok';                                    // ~4 words, 18 chars
var verboseMsg = new Array(10).join('please consider carefully whether this approach ') + 'works for our project'; // ~66 words, <1200 chars (stays inside the authored cap)
function synth(msg) {
  state.convs = [];
  for (var i = 0; i < 6; i++) state.convs.push(mkConv('u' + i, [['h', msg], ['a', 'Done. Want option 1 or option 2?'], ['h', msg]]));
  return buildProfilePack().gates;
}
var gT = synth(terseMsg), gV = synth(verboseMsg);
console.log('terse gates:   ' + JSON.stringify(gT));
console.log('verbose gates: ' + JSON.stringify(gV));
ok(gT.critWords < gV.critWords, 'critWords scales with verbosity (' + gT.critWords + ' < ' + gV.critWords + ')');
ok(gT.accWords <= gV.accWords, 'accWords scales (' + gT.accWords + ' <= ' + gV.accWords + ')');
ok(gT.critWords === 12, 'terse archive hits lower clamp (critWords=12)');
ok(gV.critWords === 40, 'verbose archive hits upper clamp (critWords=40)');
ok(gT.corrChars === 120 && gV.corrChars === 400, 'corrChars clamps both ends');

// ---------- 3. Eugen-calibration: median 68 chars / 12 words must reproduce v1.13.1 constants ----------
// (ratios were chosen for this — regression-guard the calibration)
var msg12w68c = 'lets resume the works today and check all of the searching stats'; // 12 words, then padded to 68 chars
// pad to 68 chars without adding words
while (msg12w68c.length < 68) msg12w68c = msg12w68c.replace('stats', 'statsx');
state.convs = [];
for (var i = 0; i < 6; i++) state.convs.push(mkConv('e' + i, [['h', msg12w68c], ['a', 'ok'], ['h', msg12w68c]]));
var gE = buildProfilePack().gates;
console.log('calib gates:   ' + JSON.stringify(gE));
ok(gE.critWords === 20, 'calibration = old critWords 20 (ceil; got ' + gE.critWords + ')');
ok(gE.pickWords === 15, 'calibration = old pickWords 15 (got ' + gE.pickWords + ')');
ok(gE.accWords === 8 || gE.accWords === 9, 'calibration ~ old accWords 8 (ceil; got ' + gE.accWords + ')');
ok(Math.abs(gE.corrChars - 180) <= 10, 'calibration ~ old corrChars 180 (got ' + gE.corrChars + ')');
ok(Math.abs(gE.repChars - 90) <= 6, 'calibration ~ old repChars 90 (got ' + gE.repChars + ')');

// ---------- 4. empty archive: fallback defaults, no crash ----------
state.convs = [];
var g0 = buildProfilePack().gates;
ok(g0.medianChars === 68 && g0.medianWords === 12, 'empty archive falls back to 68c/12w defaults');

// ---------- 5. scoped me.skill (v1.25.0): pack + gates recalibrate to the passed list ----------
// mixed archive: 8 terse claude convs + 4 verbose chatgpt convs (asymmetric so the MIXED
// median stays terse — that's exactly what makes the scoped recalibration observable)
state.convs = [];
for (var i = 0; i < 8; i++) state.convs.push(mkConv('c' + i, [['h', terseMsg], ['a', 'Done. ok?'], ['h', terseMsg]]));
for (var i = 0; i < 4; i++) {
  var vc = mkConv('g' + i, [['h', verboseMsg], ['a', 'Done. ok?'], ['h', verboseMsg]]);
  vc.source = 'chatgpt';
  state.convs.push(vc);
}
var pAll = buildProfilePack();
var scoped = state.convs.filter(function (c) { return (c.source || 'claude') === 'chatgpt'; });
var pScoped = buildProfilePack(scoped);
ok(pAll.convs === 12 && pScoped.convs === 4, 'scoped pack counts only the slice (' + pAll.convs + ' vs ' + pScoped.convs + ')');
ok(pScoped.gates.critWords === 40 && pAll.gates.critWords === 12,
   'gates recalibrate to the scope (scoped verbose=40, mixed-terse=' + pAll.gates.critWords + ')');
ok(buildProfilePack(state.convs.filter(function (c) { return !c.source; })).gates.critWords === 12,
   'claude-only scope hits the terse clamp (12)');
ok(buildProfilePack().convs === 12, 'no argument still means the whole archive');

// ---------- 6. v1.25.1 audit fixes: openers date-sort, totals, placeholder exclusion ----------
function mkConvD(uuid, date, opener, files) {
  return { uuid: uuid, name: 'synth ' + uuid, created_at: date, updated_at: date,
           msgCount: 2, schema: 3, fileNames: files || [],
           docs: [{ s: 'h', d: date + 'T10:00', t: opener },
                  { s: 'a', d: date + 'T10:01', t: 'Done. ok?' }] };
}
state.convs = [];
// insertion order: NEWEST first, oldest LAST — the old slice(-12) would have led with 2022
state.convs.push(mkConvD('n1', '2026-06-01', 'hello from twenty twenty six, lets resume the works'));
for (var i = 0; i < 12; i++) state.convs.push(mkConvD('o' + i, '2022-03-0' + (1 + i % 9), 'ancient chatgpt question number ' + i + ' about hotels', ['(pasted text)']));
var p6 = buildProfilePack();
ok(p6.openers.length && /2026-06-01/.test(p6.openers[0].date), 'openers lead with the NEWEST date regardless of insertion order (' + p6.openers[0].date + ')');
ok(p6.totals && p6.totals.critiques >= p6.critiques.length && p6.totals.corrections >= p6.corrections.length &&
   typeof p6.totals.vocab === 'number', 'totals present and >= kept counts');
ok(!p6.filenames.some(function (f) { return f.pattern === '(pasted text)'; }), '"(pasted text)" placeholder excluded from filename patterns');
// F9: identical opener text across chats appears once (newest kept)
state.convs.push(mkConvD('d1', '2026-05-01', 'duplicate prompt for two chats about logos today'));
state.convs.push(mkConvD('d2', '2026-05-02', 'duplicate prompt for two chats about logos today'));
var p7 = buildProfilePack();
var dups = p7.openers.filter(function (m) { return /duplicate prompt for two chats/.test(m.t); });
ok(dups.length === 1 && /2026-05-02/.test(dups[0].date), 'duplicate openers dedup to the newest (' + dups.length + ')');

// ---------- 7. v1.26.0 viewScope: multi-chip scoping shared by me.skill/stats/coach ----------
eval(slice('function srcTabSet', 'function upsertConvs'));
eval(slice('function viewScope', 'function makeMeSkill'));
state.dossier = null;
var vc1 = mkConvD('s1', '2026-01-01', 'a claude conversation opener here');
var vc2 = mkConvD('s2', '2026-01-02', 'a cowork conversation opener here'); vc2.source = 'cowork';
var vc3 = mkConvD('s3', '2026-01-03', 'a chatgpt conversation opener here'); vc3.source = 'chatgpt';
state.convs = [vc1, vc2, vc3];
state.srcTabs = [];
ok(viewScope() === null, 'no chips = whole archive (null scope)');
state.srcTabs = ['cowork', 'chatgpt'];
var vs = viewScope();
ok(vs && vs.list.length === 2 && vs.label === 'source:cowork+chatgpt',
   'multi-chip scope filters + labels (' + (vs && vs.label) + ')');
state.dossier = { convs: [vc1], label: 'query x' };
ok(viewScope().list.length === 1 && viewScope().label === 'query x', 'active query filter wins over chips');
state.dossier = null; state.srcTabs = [];

console.log('\n' + (fails ? fails + ' FAILURES / ' : 'ALL ') + checks + ' checks' + (fails ? '' : ' passed'));
process.exit(fails ? 1 : 0);
