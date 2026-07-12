// Query-router tests — runs against the REAL routeQuery/parsePeriod extracted from app.js.
// No private data needed. Usage: node test_router.js
// The router (v1.30, Eugen's validated idea) turns analytics questions ("how many example.com
// chats?", "câte ore la example.com?") into a computed answer strip. This suite is the PRECISION
// bar: flagship questions must route (right intent + subject), and normal searches must NOT
// misfire (kind:'search'). A conservative classifier is the whole point — a strip over a real
// keyword search is annoying, so the negatives matter as much as the positives.
/* no 'use strict' — direct eval must define the extracted functions in this scope */
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
function extract(name, until) {
  const start = src.indexOf('function ' + name);
  const end = src.indexOf('function ' + until);
  if (start < 0 || end < 0 || end <= start) throw new Error('cannot extract ' + name);
  return src.slice(start, end);
}
// parsePeriod + routeQuery sit together between parseQueryGroups and docPasses
eval(extract('parsePeriod', 'routeQuery') + extract('routeQuery', 'docPasses'));

// deterministic "now" so relative-period ranges are stable: Wed 2026-07-08 (month idx 6 = July)
const NOW = new Date(2026, 6, 8, 12, 0, 0);

let n = 0, failed = 0;
function eq(label, got, want) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failed++; console.error('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
}
function route(label, q, intent, subject) {
  const r = routeQuery(q, NOW);
  eq(label + ' :: kind', r.kind, 'analytics');
  if (r.kind === 'analytics') { eq(label + ' :: intent', r.intent, intent); eq(label + ' :: subject', r.subject, subject); }
}
function search(label, q) { eq(label + ' :: search', routeQuery(q, NOW).kind, 'search'); }
function period(label, q, after, before) {
  const p = routeQuery(q, NOW).period || {};
  eq(label + ' :: period.after', p.after, after);
  eq(label + ' :: period.before', p.before, before);
}

// ---------- POSITIVES: flagship examples (Eugen's own, must route) ----------
route('flagship count', 'how many example.com chats?', 'count', 'example.com');
route('flagship time RO', 'câte ore la example.com?', 'time', 'example.com');

// ---------- count ----------
route('count w/ subject', 'how many Docker chats', 'count', 'Docker');           // case preserved
route('count messages about', 'how many messages about deployment', 'count', 'deployment');
route('count times did I ask', 'how many times did I ask about nginx', 'count', 'nginx');
route('count total, no subject', 'how many conversations do I have', 'count', '');
route('count RO câte', 'câte conversații despre constructii', 'count', 'constructii');

// ---------- time ----------
route('time hours EN', 'how many hours did I spend on the nginx setup', 'time', 'nginx setup');
route('time much time', 'how much time did I spend on demo', 'time', 'demo');
route('time RO timp', 'cât timp am lucrat la site logs', 'time', 'site logs');
route('time + period subject', 'how much time did I spend in cowork last month', 'time', 'cowork');

// ---------- firstlast ----------
route('firstlast first talk', 'when did I first talk about invoicer', 'firstlast', 'invoicer');
route('firstlast start EN', 'when did I start using Docker', 'firstlast', 'Docker');
route('firstlast RO', 'când am început proiectul demo', 'firstlast', 'proiectul demo');

// ---------- activity (period-focused) ----------
route('activity month bare', 'how many chats in June', 'activity', '');
route('activity last month', 'how active was I last month', 'activity', '');
route('activity how often', 'how often did I chat about beton', 'activity', 'beton');
route('activity bare year', 'how many chats in 2025', 'activity', '');

// ---------- period ranges (deterministic vs NOW = 2026-07-08) ----------
period('period June (this yr)', 'how many chats in June', '2026-06-01', '2026-06-30');
period('period March + year', 'how many chats in March 2024', '2024-03-01', '2024-03-31');
period('period last month', 'how active was I last month', '2026-06-01', '2026-06-30');
period('period this month', 'how many chats this month', '2026-07-01', '2026-07-31');
period('period this year', 'how active was I this year', '2026-01-01', '2026-12-31');
period('period last year', 'how many chats last year', '2025-01-01', '2025-12-31');
period('period bare year', 'how many chats in 2025', '2025-01-01', '2025-12-31');
period('period December -> prior yr', 'how many chats in December', '2025-12-01', '2025-12-31'); // Dec > July → 2025

period('period June (this yr)-again', 'how many chats in June', '2026-06-01', '2026-06-30');
// single-day windows: "yesterday"/"today" are DATES, not topics (regression: was searching the word)
route('time yesterday = date not topic', 'how many hours yesterday', 'time', '');
period('period yesterday', 'how many hours yesterday', '2026-07-07', '2026-07-07');
period('period today', 'how many chats today', '2026-07-08', '2026-07-08');
period('period ieri (RO)', 'câte ore ieri', '2026-07-07', '2026-07-07');
route('RO ore ieri = date not topic', 'câte ore ieri', 'time', '');

// parsePeriod direct: "mai" (RO "more/still") must NOT be read as May
eq('RO "mai" not a month', parsePeriod('câte chat-uri mai am', NOW), null);
eq('no period -> null', parsePeriod('how many demo chats', NOW), null);

// ---------- NEGATIVES: normal searches must NOT misfire ----------
search('plain terms', 'ssh hosting');
search('plain terms 2', 'site log concrete');
search('operator source', 'source:cowork beton');
search('operator from', 'from:me demo hosting');
search('quoted phrase', '"exact phrase" test');
search('how-to', 'how to configure nginx');
search('how do I', 'how do I reset the database');
search('how does', 'how does the compression pipeline work');
search('how did', 'how did the deploy fail');
search('how many non-countable', 'how many retries before backoff'); // no countable noun, no period
search('how much cost', 'how much does it cost');
search('how long is', 'how long is the great wall');
search('when is present', 'when is the standup meeting');       // present tense, no I/first → content
search('when did the X', 'when did the build break');            // no I/first/last cue → content search

// ---------- analytics math: computeAnalytics over a synthetic conv set ----------
// (locks the numbers the strip shows; reuses the same sessionize the Stats page uses)
eval(extract('sessionize', 'srow') + extract('computeAnalytics', 'answerStripHtml'));
function doc(d, ty) { return { d: d, s: 'h', t: 'x', ty: ty }; }
const A = { docs: [doc('2026-06-01T10:00:00'), doc('2026-06-01T10:10:00'), doc('2026-06-01T10:20:00'), doc('2026-06-15T09:00:00')] };
const B = { docs: [doc('2025-12-20T12:00:00'), doc('2025-12-20T12:05:00'), doc('2026-06-01T11:00:00', 'a')] }; // last is an attachment → excluded
let a = computeAnalytics([A, B], 'count', null);
eq('compute all :: convs', a.convs, 2);
eq('compute all :: msgs (att excluded)', a.msgs, 6);
eq('compute all :: minDay', a.minDay, '2025-12-20');
eq('compute all :: maxDay', a.maxDay, '2026-06-15');
eq('compute all :: sessions', a.sessions, 3); // Dec-20, Jun-01, Jun-15 = 3 gaps > 30 min
eq('compute all :: months', a.months, { '2026-06': 4, '2025-12': 2 }); // insertion order: A (June) before B (Dec)
a = computeAnalytics([A, B], 'time', { after: '2026-06-01', before: '2026-06-30' });
eq('compute June :: convs', a.convs, 1);        // only A has in-range messages
eq('compute June :: msgs', a.msgs, 4);
eq('compute June :: sessions', a.sessions, 2);  // Jun-01 cluster + Jun-15

console.log(failed ? failed + '/' + n + ' assertions FAILED' : 'all ' + n + ' router assertions pass');
process.exit(failed ? 1 : 0);
