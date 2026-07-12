// v2.1 project-ingestion tests — normalizeProjects + the export-zip filter, all synthetic
// (no private data). Runs the REAL worker.js functions via eval, test_sessions style.
const fs = require('fs');
const path = require('path');

var self = {};
eval(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8'));

let pass = 0, failCount = 0;
function check(label, cond, extra) {
  if (cond) { pass++; }
  else { failCount++; console.error('FAIL:', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); }
}

// ---- normalizeProjects ----
const projs = [
  { uuid: 'p-1', name: 'RoomMeasure Works', created_at: '2026-04-10T05:42:14.690901+00:00',
    updated_at: '2026-04-12T09:00:00+00:00', docs: [
      { uuid: 'd1', filename: 'extract_floor.py', content: 'import ezdxf\nprint(1)', created_at: '2026-04-10T05:45:12.262088+00:00' },
      { uuid: 'd2', filename: 'HANDOVER_7.md', content: '# Handover', created_at: '2026-04-10T05:45:12.986263+00:00' },
      { uuid: 'd3', filename: 'empty.md', content: '', created_at: '2026-04-10T05:45:13+00:00' } // no content -> skipped
    ] },
  { uuid: 'p-2', name: '', is_private: true, created_at: '2026-07-02T09:53:25+00:00', docs: [] }, // empty -> skipped
  { uuid: 'p-3', name: 'One doc no name', created_at: '2026-05-01T00:00:00+00:00', docs: [
      { uuid: 'd4', content: 'body only' } // no filename -> placeholder
    ] },
  { garbage: true } // malformed -> skipped
];
const recs = normalizeProjects(projs);
check('two records (empty + malformed skipped)', recs.length === 2, recs.length);
const r1 = recs[0];
check('uuid/name/source/project mapped', r1.uuid === 'p-1' && r1.name === 'RoomMeasure Works' &&
  r1.source === 'project' && r1.project === 'RoomMeasure Works', r1);
check('dates carried', r1.created_at.indexOf('2026-04-10') === 0 && r1.updated_at.indexOf('2026-04-12') === 0,
  [r1.created_at, r1.updated_at]);
check('schema stamped', r1.schema === SCHEMA, r1.schema);
check('two docs (contentless skipped)', r1.docs.length === 2 && r1.msgCount === 2, r1.docs.length);
check('doc shape: ty a, sender h, local-minute date, content', r1.docs.every(d =>
  d.ty === 'a' && d.s === 'h' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.d) && d.t.length > 0), r1.docs);
check('fileNames match docs', JSON.stringify(r1.fileNames) === JSON.stringify(['extract_floor.py', 'HANDOVER_7.md']), r1.fileNames);
const r3 = recs[1];
check('filename placeholder', r3.docs[0].fn === '(untitled doc)', r3.docs[0].fn);
check('project doc date falls back to project date', r3.docs[0].d.indexOf('2026-05-01') === 0, r3.docs[0].d);

// ---- export-zip filter: what the worker unzips ----
// mirrors worker.js onmessage filter — keep the regex in sync (extracted here by text match)
const filterSrc = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')
  .match(/filter: function \(f\) \{ return (.+?)\.test\(f\.name\); \}/);
check('zip filter found in worker', !!filterSrc, 'pattern changed?');
if (filterSrc) {
  const re = eval(filterSrc[1]);
  check('filter: conversations.json', re.test('conversations.json'));
  check('filter: projects/*.json', re.test('projects/019d0775-810b-73d6-91f8-09849991d58c.json'));
  check('filter: nested projects path', re.test('export/projects/x.json'));
  check('filter: both archive markers', re.test('skillmint-archive.json') && re.test('colloquary-archive.json'));
  check('filter: users.json rejected', !re.test('users.json'));
  check('filter: memories.json rejected', !re.test('memories.json'));
  check('filter: design_chats rejected', !re.test('design_chats/0003b1f1.json'));
  check('filter: projects non-json rejected', !re.test('projects/readme.txt'));
}

console.log('\n' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount ? 1 : 0);
