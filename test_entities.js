// Entity-mapping tests (v1.47.0) — runs against the REAL extractors from app.js.
// No private data. Usage: node test_entities.js
/* no 'use strict' — direct eval must define the extracted functions in this scope */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
function extract(name, until) {
  const s = src.indexOf('function ' + name), e = src.indexOf('function ' + until);
  if (s < 0 || e < 0 || e <= s) throw new Error('cannot extract ' + name);
  return src.slice(s, e);
}
eval(extract('entRules', 'heatmapHtml')); // entRules + entScan + entIndex

let n = 0, failed = 0;
function ok(label, cond) { n++; if (!cond) { failed++; console.error('FAIL ' + label); } }
function kinds(text, k) { return entScan(text).filter(e => e.k === k).map(e => e.v); }

// --- domains ---
ok('domain basic', kinds('deployed to colloquary.com just now', 'domain').includes('colloquary.com'));
ok('domain subdomain', kinds('kept notes.example.com live', 'domain').includes('notes.example.com'));
ok('domain lowercased', kinds('open Colloquary.COM', 'domain').includes('colloquary.com'));
ok('file names are NOT domains', ['app.js', 'estimate.ts', 'models.py', 'chatalog.html', 'requirements.txt', 'worker.min.js']
  .every(f => kinds('open ' + f + ' now', 'domain').length === 0));
ok('library-domains like socket.io count (io is a real TLD)', kinds('use socket.io here', 'domain').includes('socket.io'));

// --- IPs ---
ok('ip basic', kinds('ssh root@203.0.113.10 now', 'ip').includes('203.0.113.10'));
ok('ip invalid octet rejected', kinds('at 999.1.1.1 nothing', 'ip').length === 0);
ok('3-group versions are not IPs', kinds('ort 1.26.0 shipped', 'ip').length === 0);
ok('bind address counts', kinds('listening on 0.0.0.0', 'ip').includes('0.0.0.0'));

// --- repos ---
ok('bare repo name', kinds('push to /srv/git/demo.git tonight', 'repo').includes('demo.git'));
ok('git@ remote repo', kinds('origin git@203.0.113.10:/srv/git/demo.git', 'repo').includes('demo.git'));
ok('github owner/repo', kinds('see github.com/anthropics/claude-code for docs', 'repo').includes('anthropics/claude-code'));
ok('github .git suffix stripped', kinds('clone https://github.com/user/thing.git now', 'repo').includes('user/thing'));

// --- paths ---
ok('home path truncated to 3 segments', kinds('edit ~/Code/chatalog/app.js please', 'path').includes('~/Code/chatalog'));
ok('etc path', kinds('in /etc/nginx/sites-enabled/colloquary', 'path').includes('/etc/nginx/sites-enabled'));
ok('short root path kept', kinds('cd ~/fits then build', 'path').includes('~/fits'));
ok('prose slashes are not paths', kinds('either/or and/or choices', 'path').length === 0);
ok('url paths are not fs paths', kinds('see colloquary.com/about today', 'path').length === 0);

// --- entIndex aggregation ---
const mk = (uuid, day, texts) => ({ uuid, docs: texts.map(t => ({ d: day + 'T10:00', t })) });
const list = [
  mk('c1', '2026-01-05', ['deploy example.com now', 'ssh 203.0.113.10', 'also example.com again']),
  mk('c2', '2026-03-10', ['example.com is live', 'push /srv/git/demo.git']),
  mk('c3', '2026-04-01', ['random chat about nothing.com'])
];
const idx = entIndex(list);
const demo = idx.domain.find(r => r.v === 'example.com');
ok('index: entity present', !!demo);
ok('index: chats distinct', demo && demo.chats === 2);
ok('index: times sum mentions', demo && demo.times === 3);
ok('index: date range first→last', demo && demo.first === '2026-01-05' && demo.last === '2026-03-10');
ok('index: one-chat entities dropped (min 2)', !idx.domain.find(r => r.v === 'nothing.com'));
ok('index: single-chat ip dropped', !idx.ip.find(r => r.v === '203.0.113.10'));
const list2 = list.concat([mk('c4', '2026-05-05', ['back on 203.0.113.10'])]);
const idx2 = entIndex(list2);
ok('index: 2nd chat rescues the ip', !!idx2.ip.find(r => r.v === '203.0.113.10'));
ok('index: sorted by chats desc', idx2.domain[0].v === 'example.com');

// --- v1.48.0: months + axis + sparkline + co-occurrence ---
ok('index: months counted', demo && demo.months['2026-01'] === 2 && demo.months['2026-03'] === 1);
ok('index: seen counts mentions per conv (v1.48.2)', demo && demo.seen && demo.seen.c1 === 2 && demo.seen.c2 === 1);
const axis = entAxis([demo]);
ok('axis: contiguous months first→last', axis.length === 3 && axis[0] === '2026-01' && axis[2] === '2026-03');
const ca = { v: 'example.com', seen: { c1: 1, c2: 1, c5: 1 } };
const cb = { v: '203.0.113.10', seen: { c1: 1, c2: 1 } };
const cc = { v: 'www.example.com', seen: { c1: 1, c2: 1 } };
const cd = { v: 'widget.cc', seen: { c9: 1 } };
const co = entCoocc([ca, cb, cc, cd]);
ok('coocc: shared-chat entity found', co['example.com'].length === 1 && co['example.com'][0].v === '203.0.113.10' && co['example.com'][0].n === 2);
ok('coocc: substring pair skipped', !co['example.com'].some(x => x.v === 'www.example.com'));
ok('coocc: no overlap → empty', co['widget.cc'].length === 0);

// --- v1.48.2: hover-card html (pure) ---
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const titles = { c1: 'Deploy demo tonight', c2: 'Resume example.com work' };
const pop = entPopHtml(demo, 'Domains & hosts', axis, u => titles[u]);
ok('pop: header + kind', pop.indexOf('example.com') >= 0 && pop.indexOf('Domains &amp; hosts') >= 0);
ok('pop: busiest month named', pop.indexOf('busiest: 2026-01 (2') >= 0);
ok('pop: one bar per axis month', (pop.match(/<i/g) || []).length === 3);
ok('pop: axis labels first/last', pop.indexOf('<span>2026-01</span>') >= 0 && pop.indexOf('<span>2026-03</span>') >= 0);
ok('pop: top conv first is the 2-mention one', pop.indexOf('Deploy demo tonight') < pop.indexOf('Resume example.com work'));
ok('pop: unknown titles skipped', entPopHtml(demo, 'x', axis, () => '').indexOf('ep-convs') < 0);
ok('pop: empty month bar gets .z', pop.indexOf('class="z"') >= 0);
// v1.49.0 — inline cassette opts: name as search link + appears-with line
const card = entPopHtml(demo, 'Domains & hosts', axis, u => titles[u], { link: true, coHtml: '<a class="entq" data-q="x">x</a>' });
ok('card: name is a search link', card.indexOf('class="entq" data-q="example.com"') >= 0);
ok('card: appears-with appended', card.indexOf('appears with:') >= 0 && card.indexOf('data-q="x"') >= 0);
ok('card: no opts → plain name, no co line', pop.indexOf('class="entq"') < 0 && pop.indexOf('appears with:') < 0);

console.log((failed ? 'FAILED ' : 'OK ') + (n - failed) + '/' + n + ' entity checks');
process.exit(failed ? 1 : 0);
