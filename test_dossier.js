// buildDossier regression tests — runs against the REAL function extracted from app.js.
// No private data needed. Usage: node test_dossier.js
// Guards: chronological order (created_at ASC regardless of input order), full-conv content,
// attachment inlining with 📎 + filename, header counts/range, datetime rendering, label fallback.
/* no 'use strict' — direct eval must be able to define the extracted functions in this scope */
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
function extract(name, until) {
  const start = src.indexOf('function ' + name);
  const end = src.indexOf('function ' + until);
  if (start < 0 || end < 0 || end <= start) throw new Error('cannot extract ' + name);
  return src.slice(start, end);
}
// dDay/dNice sit at the top of app.js (the chunk up to openDB also defines the harmless $/state);
// buildDossier ends where renderCard starts
eval(extract('dDay', 'openDB') + extract('buildDossier', 'renderCard'));

let n = 0, failed = 0;
function ok(label, cond) {
  n++;
  if (!cond) { failed++; console.error('FAIL ' + label); }
}

const convs = [
  { uuid: 'b', name: 'Supplements plan', created_at: '2026-05-02T10:00', updated_at: '2026-05-03T09:00', source: 'claude',
    docs: [
      { s: 'h', d: '2026-05-02T10:00', t: 'ce suplimente pentru fier?' },
      { s: 'a', d: '2026-05-02T10:01', t: 'Fier bisglicinat, cu vitamina C.' },
      { s: 'h', d: '2026-05-02T10:05', ty: 'a', fn: 'analize mai.txt', t: 'Feritina: 9 ng/mL\nHemoglobina: 11.2' }
    ] },
  { uuid: 'a', name: 'Deficiencies intro', created_at: '2026-04-01T08:00', updated_at: '2026-04-01T08:30',
    docs: [
      { s: 'h', d: '2026-04-01T08:00', t: 'oboseala constanta, ce analize?' },
      { s: 'a', d: '2026-04-01T08:01', t: 'Feritina, B12, vitamina D.' }
    ] },
  { uuid: 'c', name: 'Cowork meal planner', created_at: '2026-06-10T12:00', updated_at: '2026-06-10T13:00', source: 'cowork', project: 'meals',
    docs: [
      { s: 'h', d: '2026-06-10T12:00', t: 'make a weekly iron-rich meal plan' }
    ] }
];

// deliberately shuffled input (b, a, c) — output must be a, b, c by created_at
const md = buildDossier(convs, 'carente OR suplimente');
const lines = md.split('\n');

ok('H1 carries label', lines[0] === '# colloquary dossier — carente OR suplimente');
ok('header counts', md.indexOf('3 conversations · 6 messages') >= 0);
ok('header range lo→hi', md.indexOf('2026-04-01 → 2026-06-10') >= 0);

const ixA = md.indexOf('## 2026-04-01 — Deficiencies intro');
const ixB = md.indexOf('## 2026-05-02 — Supplements plan');
const ixC = md.indexOf('## 2026-06-10 — Cowork meal planner');
ok('all three conv headers present', ixA >= 0 && ixB >= 0 && ixC >= 0);
ok('chronological order (input was shuffled)', ixA < ixB && ixB < ixC);

ok('absent source defaults to claude', md.indexOf('Deficiencies intro  (claude · 2 msg)') >= 0);
ok('source + folder in header', md.indexOf('(cowork · 📁 meals · 1 msg)') >= 0);

ok('user turn labeled You with datetime', md.indexOf('**You** (2026-04-01 08:00):') >= 0);
ok('assistant turn labeled Claude', md.indexOf('**Claude** (2026-04-01 08:01):') >= 0);
ok('attachment marked 📎 with filename', md.indexOf('**📎 analize mai.txt** (2026-05-02 10:05):') >= 0);
ok('attachment CONTENT inlined (lab values are the data)', md.indexOf('Feritina: 9 ng/mL') >= 0);
ok('attachment not labeled as a turn', md.indexOf('**You** (2026-05-02 10:05)') < 0);

ok('full text present, not snippets', md.indexOf('Fier bisglicinat, cu vitamina C.') >= 0);
ok('conversations separated by hr', (md.match(/^---$/gm) || []).length === 3);

// single conversation: singular wording, no crash on missing updated_at
const md1 = buildDossier([{ uuid: 'x', name: 'One', created_at: '2026-01-05T09:00', docs: [{ s: 'h', d: '2026-01-05T09:00', t: 'hi' }] }], '');
ok('singular conversation wording', md1.indexOf('1 conversation · 1 messages') >= 0);
ok('empty label falls back', md1.indexOf('# colloquary dossier — ') === 0);
ok('range collapses to same day', md1.indexOf('2026-01-05 → 2026-01-05') >= 0);

// date-only docs (pre-SCHEMA-3 records) must render without T artifacts
const md2 = buildDossier([{ uuid: 'y', name: 'Old', created_at: '2025-11-02', docs: [{ s: 'a', d: '2025-11-02', t: 'old reply' }] }], 'old');
ok('date-only doc renders clean', md2.indexOf('**Claude** (2025-11-02):') >= 0);

if (failed) { console.error(failed + ' of ' + n + ' checks failed'); process.exit(1); }
console.log('ALL ' + n + ' dossier checks passed');
