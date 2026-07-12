// parseQuery regression tests — runs against the REAL functions extracted from app.js.
// No private data needed. Usage: node test_query.js
// Born from the v1.11.2 bug: `var key, val;` in parseQuery's token loop is function-scoped,
// so a stale key from a previous operator token swallowed every later plain term
// ("from:me demo hosting" parsed as terms:[]). Same family as the v1.7.1 `var groups` shadowing.
/* no 'use strict' — direct eval must be able to define the extracted functions in this scope */
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
function extract(name, until) {
  const start = src.indexOf('function ' + name);
  const end = src.indexOf('function ' + until);
  if (start < 0 || end < 0 || end <= start) throw new Error('cannot extract ' + name);
  return src.slice(start, end);
}
// normalizeDate + pad2 sit together before parseQuery; parseQuery ends where parseQueryGroups starts
eval(extract('normalizeDate', 'parseQuery') + extract('parseQuery', 'docPasses'));

let n = 0, failed = 0;
function eq(label, got, want) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failed++; console.error('FAIL ' + label + '\n  got  ' + g + '\n  want ' + w); }
}

// --- v1.11.2 regression: terms AFTER an operator must survive ---
let q = parseQuery('from:me example.com hosting');
eq('terms after from:', q.terms, ['example.com', 'hosting']);
eq('from still parsed', q.from, 'h');

q = parseQuery('"demo" from:me hosting');
eq('term after phrase+operator', q.terms, ['hosting']);
eq('phrase kept', q.phrases, ['demo']);
eq('from kept', q.from, 'h');

q = parseQuery('source:cowork after:2026-06 sapa beton');
eq('terms after two operators', q.terms, ['sapa', 'beton']);
eq('source', q.source, 'cowork');
eq('after normalized', q.after, '2026-06');

// quoted operator value followed by a term (v1.11.0 feature + v1.11.2 fix together)
q = parseQuery('folder:"site logs" beton');
eq('term after quoted operator', q.terms, ['beton']);
eq('quoted folder value', q.folder, 'site logs');

q = parseQuery('chat:"long title" from:me -noise "exact phrase" word');
eq('mixed: terms', q.terms, ['word']);
eq('mixed: chat', q.chat, 'long title');
eq('mixed: from', q.from, 'h');
eq('mixed: excludes', q.excludes, ['noise']);
eq('mixed: phrases', q.phrases, ['exact phrase']);

// --- baseline behaviors (must not regress) ---
q = parseQuery('plain words only');
eq('plain terms', q.terms, ['plain', 'words', 'only']);
eq('plain from null', q.from, null);

q = parseQuery('a AND b');
eq('explicit AND is a no-op', q.terms, ['a', 'b']);

q = parseQuery('-excluded kept');
eq('exclude', q.excludes, ['excluded']);
eq('exclude keeps term', q.terms, ['kept']);

q = parseQuery('has:attachment file:report.pdf');
eq('hasAtt', q.hasAtt, true);
eq('file', q.file, 'report.pdf');

q = parseQuery('before:2026.05.03 x');
eq('dot date normalized', q.before, '2026-05-03');
eq('term after date op', q.terms, ['x']);

q = parseQuery('unknown:value stays');
eq('unknown op is a term', q.terms, ['unknown:value', 'stays']);

const groups = parseQueryGroups('alpha OR from:me beta');
eq('OR group count', groups.length, 2);
eq('OR g0 terms', groups[0].terms, ['alpha']);
eq('OR g1 terms', groups[1].terms, ['beta']);
eq('OR g1 from', groups[1].from, 'h');

// --- v2.1: source:project (and prefix form) ---
q = parseQuery('source:project brief');
eq('source project', q.source, 'project');
eq('terms after source:project', q.terms, ['brief']);
eq('source pro prefix', parseQuery('source:pro x').source, 'project');
eq('source cowork unaffected', parseQuery('source:cowork x').source, 'cowork');

console.log(failed ? failed + '/' + n + ' assertions FAILED' : 'all ' + n + ' parseQuery assertions pass');
process.exit(failed ? 1 : 0);
