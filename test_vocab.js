// test_vocab.js — derived acceptance/rejection vocabulary (me.skill universal, backlog §11b)
// Proves the pivot extractors work on a NON-EN/RO archive with zero lexicon help:
// accept-words derived from conversation-enders (lift vs general usage kills glue words),
// reject-words derived from rework loops (retry ≈ rejected by word overlap).
// Also regression-guards the real samples/. Run: node test_vocab.js
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
eval(slice('function fold(s)', 'function esc('));
eval(slice('var MS_STOP', 'function renderMeSkill'));

var state = { convs: [] };
var fails = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { fails++; console.log('FAIL: ' + msg); } else console.log('ok:   ' + msg); }

function mkConv(uuid, msgs) {
  return { uuid: uuid, name: 'synth ' + uuid, created_at: '2026-01-01', updated_at: '2026-01-02',
           msgCount: msgs.length, schema: 3, fileNames: [],
           docs: msgs.map(function (m, i) { return { s: m[0], d: '2026-01-01T10:' + String(10 + i).slice(-2), t: m[1] }; }) };
}

// ---------- 1. synthetic pseudo-Swedish archive (no EN/RO cue anywhere) ----------
// "och"/"det" are glue (appear everywhere incl. enders) → lift must exclude them.
// "tack/toppen/jobbat" close conversations → derived accept. "nej/fel/trasigt" trigger
// reworks (retry repeats the rejected message's distinctive words) → derived reject.
var mid = 'kan du och det uppdatera sidfoten med versionsnummer och det datumet visas'; // ~12 words glue-heavy
var rejected = 'Jag har uppdaterat funktionen paginering datumfilter sortering enligt specifikationen och det';
var retry = 'Du har ratt - funktionen paginering datumfilter sortering ar nu korrigerad enligt specifikationen';
var away = 'Har ar en helt annan sak om bakgrundsfarger typsnitt marginaler layouten istallet';
for (var i = 0; i < 8; i++) {
  var msgs = [
    ['h', mid], ['a', 'Klart, sidfoten och det ar uppdaterad nu med bade versionsnummer och datum.'],
    ['h', mid + ' igen tack'], // mid-conv acceptance-ish use of tack is rare: only here
  ];
  msgs = [
    ['h', mid],
    ['a', rejected],
    ['h', i < 4 ? 'nej fel fortfarande trasigt och det' : mid],   // rejection scene in 4 chats
    ['a', i < 4 ? retry : away],
    ['h', mid],
    ['a', 'Klart och det.'],
    ['h', 'toppen tack bra jobbat och det']                        // ender in every chat
  ];
  state.convs.push(mkConv('sv' + i, msgs));
}
var p = buildProfilePack();
var V = p.derivedVocab;
console.log('derived accept: ' + JSON.stringify(V.accept));
console.log('derived reject: ' + JSON.stringify(V.reject));
console.log('gates: accWords=' + p.gates.accWords + ' critWords=' + p.gates.critWords);
ok(V.accept['tack'] && V.accept['toppen'] && V.accept['jobbat'], 'ender words derived as accept (tack/toppen/jobbat)');
ok(!V.accept['och'] && !V.accept['det'], 'glue words excluded from accept by lift');
ok(V.reject['nej'] && V.reject['fel'], 'rework-loop words derived as reject (nej/fel)');
ok(!V.reject['och'] && !V.reject['det'], 'glue words excluded from reject by lift');
ok(p.acceptance.some(function (a) { return a.phrase.indexOf('tack') >= 0; }),
   'acceptance markers found WITHOUT lexicon (' + JSON.stringify(p.acceptance.map(function (a) { return a.phrase; })) + ')');
ok(p.critiques.length >= 1 && /nej fel/.test(p.critiques[0].said),
   'critique delta found WITHOUT lexicon (' + (p.critiques[0] ? p.critiques[0].said : 'none') + ')');

// ---------- 2. EN archive must not regress: lexicon path still works standalone ----------
state.convs = [];
for (var j = 0; j < 4; j++) {
  state.convs.push(mkConv('en' + j, [
    ['h', 'please update the footer with the version number and current date shown'],
    ['a', 'I updated the pagination component with date filters and sorting options.'],
    ['h', j < 2 ? 'no, still the same problem here' : 'looks fine, continue with the rest'],
    ['a', 'Let me check the actual pagination component date filters sorting options again.'],
    ['h', 'ok perfect']
  ]));
}
var p2 = buildProfilePack();
ok(p2.acceptance.some(function (a) { return a.phrase === 'ok perfect'; }), 'EN acceptance via seed lexicon still works');
ok(p2.critiques.length >= 1, 'EN critique via seed lexicon still works');

// ---------- 2b. dominant polarity: "patched ok" ×many must keep "patched" out of reject ----------
// even when "patched still same" rework replies exist (2026-07-03 A/B regression on real archive)
state.convs = [];
for (var k = 0; k < 6; k++) {
  var docs = [
    ['h', 'please refactor the pagination component with proper date filters everywhere'],
    ['a', 'Refactored the pagination component date filters sorting everywhere as requested.'],
    ['h', k < 2 ? 'patched, still same error here' : 'patched ok'],
    ['a', 'Let me redo the pagination component date filters sorting everywhere differently.'],
    ['h', 'patched ok'],
    ['a', 'Great.'],
    ['h', 'patched ok']  // ender
  ];
  state.convs.push(mkConv('pt' + k, docs));
}
var p2b = buildProfilePack();
console.log('2b derived reject: ' + JSON.stringify(p2b.derivedVocab.reject));
ok(!p2b.derivedVocab.reject['patched'], 'dominant polarity: "patched" NOT a reject word');
ok(p2b.acceptance.some(function (a) { return a.phrase === 'patched ok'; }),
   '"patched ok" survives as acceptance marker');

// ---------- 3. real samples: no crash, no pivot regression ----------
var dir = path.join(__dirname, 'samples');
if (fs.existsSync(dir)) {
  state.convs = [];
  fs.readdirSync(dir).filter(function (f) { return /^main_.*\.jsonl$/.test(f); }).forEach(function (f) {
    var metaFile = path.join(dir, f.replace('.jsonl', '.meta.json'));
    var meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
    var uuid = meta ? String(meta.cliSessionId).toLowerCase() : f;
    var conv = normalizeSession(fs.readFileSync(path.join(dir, f), 'utf8'), meta, uuid, '.claude/projects/-Users-eugen-x/' + uuid + '.jsonl');
    if (conv) state.convs.push(conv);
  });
  var p3 = buildProfilePack();
  console.log('samples derived accept: ' + JSON.stringify(p3.derivedVocab.accept));
  console.log('samples derived reject: ' + JSON.stringify(p3.derivedVocab.reject));
  ok(p3.critiques.length >= 1, 'samples: critiques not lost (' + p3.critiques.length + ')');
  ok(p3.decisions.length + p3.bareApprovals >= 8, 'samples: decisions not lost (' + p3.decisions.length + '+' + p3.bareApprovals + ' bare)');
} else console.log('samples/ not found — skipping');

// ---- v1.25.1 (audit F1): derive-candidate hygiene ----
ok(typeof msDeriveOk === 'function', 'msDeriveOk exists');
ok(!msDeriveOk('2kb') && !msDeriveOk('px') && !msDeriveOk('po') && !msDeriveOk('486kb'),
   'size fragments / 2-letter shards rejected as derive candidates');
ok(msDeriveOk('wait') && msDeriveOk('gresit') && msDeriveOk('same'), 'real words still qualify');

// scp/rsync progress lines are pastes, not authored voice (audit F3)
ok(msProse('fixed it\nog.png 100% 60KB 486.3KB/s 00:00') === 'fixed it', 'scp progress line stripped after prose');
ok(msProse('og.png  100%   60KB 486.3KB/s   00:00') === '', 'pure scp paste yields no prose');
// audit cycle 2 fix 6 (v1.42.0): git commit summaries + unzip output leaked as design critiques
ok(msProse('[main bffc8cb] fix: FAQ #6 sticker size — 2.5×2.5 cm, not 7×7') === '', 'git commit summary line is paste');
ok(msProse('Archive: /tmp/demo_v3_1_full.zip\n  inflating: demo_app/requirements.txt') === '', 'unzip output is paste');
ok(msProse('looks wrong\n  inflating: demo_app/models.py') === 'looks wrong', 'prose before unzip output survives');
// v1.46.1 (merged-skill QA): vitest rows, rsync summaries, Claude Code UI chrome leaked as rituals
ok(msProse('✓ components/__tests__/DropZone.test.tsx (3)') === '', 'vitest passing row is paste');
ok(msProse('tests green\n✓ lib/__tests__/analyze.test.ts (1)') === 'tests green', 'prose before vitest row survives');
ok(msProse('sent 183809 bytes  received 95666 bytes  531220 bytes/sec') === '', 'rsync summary is paste');
ok(msProse('deployed ok\nsent 12 bytes received 34 bytes total size is 99 speedup is 1.5') === 'deployed ok', 'prose before rsync summary survives');
ok(msProse('Read 120 lines (ctrl+r to expand)') === '', 'claude-code ui chrome is paste');
ok(msProse('ok, saved. check the diff') === 'ok, saved. check the diff', 'plain prose untouched by the new guards');

console.log('\n' + (fails ? fails + ' FAILURES / ' : 'ALL ') + checks + ' checks' + (fails ? '' : ' passed'));
process.exit(fails ? 1 : 0);
