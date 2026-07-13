// Extractive-summary tests — runs against the REAL builders extracted from app.js.
// No private data. Usage: node test_summary.js
// Covers the compiler recipe #1 spine: buildConvSummary (one chat) + buildSetSummary (a scope).
/* no 'use strict' — direct eval must define the extracted functions in this scope */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
function extract(name, until) {
  const s = src.indexOf('function ' + name), e = src.indexOf('function ' + until);
  if (s < 0 || e < 0 || e <= s) throw new Error('cannot extract ' + name);
  return src.slice(s, e);
}
// stubs the builders lean on (defined elsewhere in app.js / trivial)
function dDay(d) { return (d || '').slice(0, 10); }
function dNice(d) { return (d || '').replace('T', ' '); }
var SCHEMA = 3;
function openReader() {}
function msRedact(s) { return String(s == null ? '' : s).replace(/SECRET/g, '[redacted]'); } // stub: the real one masks API keys / emails / tokens
// real sessionize (buildSetSummary reuses it) + the whole summary block (sumClean..previewSummary)
eval(extract('sessionize', 'srow'));
eval(extract('sumClean', 'renderCard'));
eval(extract('renderMeSkill', 'makeMeSkill')); // renderMeSkill + SKILL_RECIPES + recipeSlug + deliverSkill

let n = 0, failed = 0;
function ok(label, cond) { n++; if (!cond) { failed++; console.error('FAIL ' + label); } }
function has(label, hay, needle) { ok(label + ' :: "' + needle + '"', hay.indexOf(needle) >= 0); }
function no(label, hay, needle) { n++; if (hay.indexOf(needle) >= 0) { failed++; console.error('FAIL ' + label + ' :: should NOT contain "' + needle + '"'); } }

const A = {
  uuid: 'a1', name: 'Deploy the worker', source: 'cowork',
  created_at: '2026-06-01T09:00', updated_at: '2026-06-01T10:30',
  fileNames: ['worker.js', 'deploy.sh', 'worker.js'], // dupe on purpose → must dedupe
  docs: [
    { s: 'h', d: '2026-06-01T09:00', t: 'how do i deploy the worker to the vps without downtime?' },
    { s: 'a', d: '2026-06-01T09:05', t: 'You can use a blue-green swap. First build the artifact, then symlink the new release and reload the service, so the old process keeps serving until the reload completes. Full sequence with rollback follows below.' },
    { s: 'h', d: '2026-06-01T09:10', t: 'ok, go' },
    { s: 'a', d: '2026-06-01T09:15', t: 'Great. Step one: rsync the build to a timestamped releases dir. Step two: repoint the current symlink. Step three: reload the service. I will add a health-check gate so a bad release aborts before the swap.' },
    { s: 'a', d: '2026-06-01T09:20', t: 'Done.' },
    { s: 'a', d: '2026-06-01T09:21', t: 'This attachment is not dialogue and must be ignored by the message count and key points entirely.', ty: 'a', fn: 'deploy.sh' },
    { s: 'h', d: '2026-06-01T09:25', t: 'perfect, thanks' }
  ]
};
const B = {
  uuid: 'b1', name: 'Pricing question', source: 'claude',
  created_at: '2026-06-03T14:00', updated_at: '2026-06-03T14:20', fileNames: [],
  docs: [
    { s: 'h', d: '2026-06-03T14:00', t: 'what should i price the pro tier at?' },
    { s: 'a', d: '2026-06-03T14:05', t: 'It depends on positioning and your value metric; anchoring to the outcome usually beats cost-plus.' },
    { s: 'h', d: '2026-06-03T14:20', t: 'but would that scare off small teams?' }
  ]
};

// --- buildConvSummary(A): rich chat ---
const sa = buildConvSummary(A);
has('A title', sa, '# Summary — Deploy the worker');
has('A honest label', sa, 'nothing generated');
has('A meta source', sa, 'cowork');
has('A msg count excludes attachment (6 dialogue)', sa, '· 6 messages');
has('A the ask', sa, '**The ask**');
has('A ask text', sa, 'deploy the worker to the vps');
has('A key points', sa, '**Key points**');
has('A key point lead sentence', sa, 'You can use a blue-green swap.');
no('A key points exclude attachment text', sa, 'not dialogue and must be ignored');
has('A decisions', sa, '**Decisions you made**');
has('A decision 1', sa, 'ok, go');
has('A decision 2 (perfect)', sa, 'perfect, thanks');
has('A files line', sa, '**Files:**');
has('A files deduped', sa, 'worker.js · deploy.sh');
no('A not open (last is not a question)', sa, '**Possibly open**');

// --- buildConvSummary(B): open thread ---
const sb = buildConvSummary(B);
has('B open thread', sb, '**Possibly open**');
has('B open text', sb, 'scare off small teams');
no('B no files line', sb, '**Files:**');

// --- buildSetSummary ---
const ss = buildSetSummary([B, A], 'test set'); // pass out of order → must sort oldest first
has('set title', ss, '# Summary — test set');
has('set count', ss, '2 conversations');
has('set range', ss, '2026-06-01 → 2026-06-03');
has('set hours', ss, 'h across');
has('set sources', ss, 'Sources:');
has('set source cowork', ss, 'cowork 1');
has('set source claude', ss, 'claude 1');
has('set conv list', ss, '## Conversations');
has('set lists A', ss, 'Deploy the worker (cowork)');
has('set lists B', ss, 'Pricing question (claude)');
ok('set chronological (A before B)', ss.indexOf('Deploy the worker') < ss.indexOf('Pricing question'));

// --- buildLensSummary (custom lens: pre-resolved semantic passages) ---
const passages = [
  { s: 'a', date: '2026-06-01T09:05', conv: 'Deploy the worker', source: 'cowork', text: 'Use a blue-green swap so there is no downtime. Symlink the new release and reload the service.', score: 0.91 },
  { s: 'h', date: '2026-05-02T11:00', conv: 'VPS setup', source: 'claude', text: 'how do i do zero-downtime deploys on the vps?', score: 0.88 },
  { s: 'a', ty: 'a', fn: 'deploy.sh', date: '2026-06-01T09:20', conv: 'Deploy the worker', source: 'cowork', text: 'rsync build releases/$TS; ln -sfn releases/$TS current; systemctl reload worker', score: 0.80 }
];
const sl = buildLensSummary('zero downtime deploys', passages);
has('lens title', sl, '# Compiled — "zero downtime deploys"');
has('lens honest note', sl, 'pulled verbatim');
has('lens count', sl, '3 passages across 2 conversations');
has('lens passages section', sl, '## On-topic passages');
has('lens assistant passage', sl, '**assistant** · 2026-06-01 · Deploy the worker');
has('lens you passage', sl, '**you** · 2026-05-02 · VPS setup');
has('lens attachment labeled', sl, '📎 deploy.sh');
has('lens conversations section', sl, '## Conversations');
has('lens conv aggregate', sl, 'Deploy the worker (cowork) — 2 passages');
ok('lens convs ranked by best score (Deploy before VPS)', sl.indexOf('Deploy the worker (cowork)') < sl.indexOf('VPS setup (claude)'));
no('lens no coverage note when omitted', sl, 'Thin topic');
// coverage note (adaptive cutoff) renders above the passages when provided
const slc = buildLensSummary('x', passages, 'Thin topic — only 3 strong matches; broaden the phrase.');
has('lens coverage note', slc, '_Thin topic — only 3 strong matches; broaden the phrase._');
ok('lens coverage above passages', slc.indexOf('Thin topic') < slc.indexOf('## On-topic'));

// --- redaction wired into the builders (stub turns SECRET → [redacted]) ---
const secretConv = { uuid: 's1', name: 'Env setup', source: 'claude', created_at: '2026-06-10T09:00', updated_at: '2026-06-10T09:30', fileNames: [],
  docs: [{ s: 'h', d: '2026-06-10T09:00', t: 'my key is SECRET please store it' }, { s: 'a', d: '2026-06-10T09:05', t: 'Do not paste SECRET in chats; setup below has SECRET masked.' }] };
const scv = buildConvSummary(secretConv);
no('conv summary redacts the ask', scv, 'SECRET');
has('conv summary shows redaction marker', scv, '[redacted]');
const secretPassages = [{ s: 'a', date: '2026-06-10T09:05', conv: 'Env setup', source: 'claude', text: 'here is SECRET in a passage', score: 0.9 }];
const spl = buildLensSummary('env', secretPassages, '', '');
no('lens redacts passage text', spl, 'SECRET');
has('lens shows redaction marker', spl, '[redacted]');
has('lens shows relevance score', spl, '`0.90`');
// --- calibration line renders when provided ---
const scal = buildLensSummary('x', passages, '', 'scores — best 0.910 · lowest shown 0.800 · (calibration)');
has('lens calib line', scal, '_scores — best 0.910 · lowest shown 0.800 · (calibration)_');

// --- preset recipe → .skill framing (renderMeSkill recipe param + registry) ---
const rpack = { convs: 12, range: '2026-01-01 → 2026-06-30', stats: { medianLen: 60, greetsPct: 0, pleasePct: 0, questionsPct: 0, nonAsciiPct: 0 },
  rituals: [], corrections: [], critiques: [], decisions: [], acceptance: [], repeats: [], labels: [], filenames: [], vocab: [], openers: [], totals: {} };
const rmd = renderMeSkill('eugen-coding', rpack, { label: 'coding', intro: 'How eugen ships code.', useWhen: 'writing code', person: 'eugen' });
has('recipe frontmatter name', rmd, 'name: about-eugen-coding');
has('recipe title uses person + label', rmd, '# eugen — coding');
has('recipe description', rmd, 'How eugen approaches coding');
has('recipe intro', rmd, 'How eugen ships code.');
has('recipe lens note', rmd, '**Lens:**');
const dmd = renderMeSkill('eugen', rpack); // default me.skill path unchanged
has('default me.skill title', dmd, '# Working with eugen');
no('default me.skill has no recipe lens', dmd, '**Lens:**');
has('registry coding lens has git', SKILL_RECIPES.coding.lens, 'git');
ok('recipeSlug slugifies', recipeSlug('My Debugging Style!') === 'my-debugging-style');
// pattern-relevance filter: per-recipe keyword predicates keep on-topic, drop off-topic
ok('coding kw matches deploy/git', SKILL_RECIPES.coding.kw.test('git push to deploy on the vps'));
ok('coding kw rejects pure design', !SKILL_RECIPES.coding.kw.test('center the button, more padding'));
ok('design kw matches layout', SKILL_RECIPES.design.kw.test('the layout spacing is off, center it'));
ok('design kw rejects deploy', !SKILL_RECIPES.design.kw.test('git commit and push to hosting'));
ok('writing kw matches copy/tone', SKILL_RECIPES.writing.kw.test('fix the tagline, the tone is off'));
// audit cycle 2 fix 4 (v1.42.0): ubiquitous tokens dropped — measured 1/8 precision from word/text/name/copy
ok('writing kw drops bare word', !SKILL_RECIPES.writing.kw.test('the orange dot is too far from the end of the word'));
ok('writing kw drops bare text/name', !SKILL_RECIPES.writing.kw.test('select text on signed pages') && !SKILL_RECIPES.writing.kw.test('it was a person, starting with H'));
ok('writing kw keeps authoring terms', SKILL_RECIPES.writing.kw.test('adjust the weather wording') && SKILL_RECIPES.writing.kw.test('do not translate mot a mot') && SKILL_RECIPES.writing.kw.test('naming the archive'));

// --- v1.46.0 merge skills: mergeRecipes (compile-time union, pure) ---
const mparts = [
  { label: SKILL_RECIPES.coding.label, lens: SKILL_RECIPES.coding.lens, kw: SKILL_RECIPES.coding.kw, intro: SKILL_RECIPES.coding.intro, useWhen: SKILL_RECIPES.coding.useWhen },
  { label: SKILL_RECIPES.design.label, lens: SKILL_RECIPES.design.lens, kw: SKILL_RECIPES.design.kw, intro: SKILL_RECIPES.design.intro, useWhen: SKILL_RECIPES.design.useWhen }
];
const merged = mergeRecipes(mparts);
ok('merge label joins with +', merged.label === 'coding + design');
ok('merge keeps parts for per-lens scans', merged.parts.length === 2 && merged.parts[0].kw === SKILL_RECIPES.coding.kw);
ok('merge lens fallback joins both', merged.lens.indexOf('git') >= 0 && merged.lens.indexOf('spacing') >= 0);
has('merge intro names both topics', merged.intro, 'coding, design');
has('merge useWhen chains both', merged.useWhen, '; also when ');
ok('merge slug', recipeSlug(merged.label) === 'coding-design');
const mmd = renderMeSkill('eugen-coding-design', rpack, { label: merged.label, intro: merged.intro, useWhen: merged.useWhen, person: 'eugen' });
has('merged skill frontmatter', mmd, 'name: about-eugen-coding-design');
has('merged skill title', mmd, '# eugen — coding + design');
has('merged skill lens note names both', mmd, 'on "coding + design"');
// merged kw predicate = OR of parts (the compile-time behavior)
const mOr = function (t) { return mparts.some(function (p) { return p.kw.test(t); }); };
ok('merged kw keeps coding', mOr('git push to deploy on the vps'));
ok('merged kw keeps design', mOr('center the button, more padding'));
ok('merged kw drops off-topic', !mOr('what should i price the pro tier at'));

// --- v1.55.0 audit cycle 3 (§12): mergeFill — round-robin union, no part starvation ---
const idsA = Array.from({ length: 200 }, (_, i) => 'a' + i);
const idsB = Array.from({ length: 60 }, (_, i) => 'b' + i);
const mf = mergeFill([idsA, idsB], 150);
ok('mergeFill: cap respected', mf.order.length === 150);
ok('mergeFill: later part NOT starved (all 60 of B in)', mf.perCount[1] === 60 && mf.perCount[0] === 90);
ok('mergeFill: perCount sums to what shipped', mf.perCount[0] + mf.perCount[1] === mf.order.length);
const mfR = mergeFill([idsB, idsA], 150);
ok('mergeFill: order flip keeps both parts (B 60 · A 90)', mfR.perCount[0] === 60 && mfR.perCount[1] === 90);
const mfOv = mergeFill([['x1', 'x2', 'x3'], ['x2', 'y1']], 150);
/* round-robin: B reaches x2 in round 1 before A does in round 2 — overlap counts for whoever gets there first */
ok('mergeFill: overlap deduped, counted once', mfOv.order.length === 4 && mfOv.perCount[0] === 2 && mfOv.perCount[1] === 2 && mfOv.perCount[0] + mfOv.perCount[1] === mfOv.order.length);
const mfOne = mergeFill([idsA.slice(0, 150)], 150);
ok('mergeFill: single part = passthrough', mfOne.order.length === 150 && mfOne.perCount[0] === 150 && mfOne.order[0] === 'a0' && mfOne.order[149] === 'a149');
const mfBoth = mergeFill([idsA, Array.from({ length: 180 }, (_, i) => 'c' + i)], 150);
ok('mergeFill: two broad parts split the cap 75/75', mfBoth.perCount[0] === 75 && mfBoth.perCount[1] === 75);

console.log((failed ? 'FAILED ' : 'OK ') + (n - failed) + '/' + n + ' assertions');
process.exit(failed ? 1 : 0);
