// v2.2 ChatGPT-adapter tests — synthetic mapping trees, no private data.
// The real export has zero branches (checked 2026-07-07), so the branch/edit resolution
// is proven HERE: the walk-back from current_node must exclude abandoned siblings.
const fs = require('fs');
const path = require('path');

var self = {};
eval(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8'));

let pass = 0, failCount = 0;
function check(label, cond, extra) {
  if (cond) { pass++; }
  else { failCount++; console.error('FAIL:', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); }
}

function node(id, parent, children, msg) { return { id, parent, children, message: msg }; }
function msg(role, text, extra) {
  return Object.assign({ author: { role }, create_time: 1783407600 + (extra && extra.dt || 0),
    content: { content_type: 'text', parts: [text] }, metadata: (extra && extra.meta) || {} }, (extra && extra.over) || {});
}

// tree with an EDIT branch: root -> u1 -> a1 -> {u2a (abandoned), u2b} ; u2b -> a2 = current
const branched = {
  conversation_id: 'cccccccc-1111-2222-3333-444444444444',
  title: 'Branch test', create_time: 1783407600, update_time: 1783411200,
  current_node: 'a2',
  mapping: {
    root: node('root', null, ['u1'], null),
    u1: node('u1', 'root', ['a1'], msg('user', 'first question')),
    a1: node('a1', 'u1', ['u2a', 'u2b'], msg('assistant', 'first answer', { meta: { model_slug: 'gpt-4o' } })),
    u2a: node('u2a', 'a1', [], msg('user', 'ABANDONED edit — must not import')),
    u2b: node('u2b', 'a1', ['a2'], msg('user', 'second question, edited', { dt: 60 })),
    a2: node('a2', 'u2b', [], msg('assistant', 'final answer', { dt: 120, meta: { model_slug: 'gpt-4o-mini' } }))
  }
};

// junk-handling conv: system + tool + hidden + thoughts + image part + attachment names
const junky = {
  id: 'dddddddd-1111-2222-3333-444444444444', // id fallback (no conversation_id)
  title: '', create_time: 1783407600, default_model_slug: 'gpt-4o',
  current_node: 'a9',
  mapping: {
    root: node('root', null, ['s1'], null),
    s1: node('s1', 'root', ['u1'], msg('system', 'system prompt — skip')),
    u1: node('u1', 's1', ['t1'], msg('user', 'real question', { meta: { attachments: [{ name: 'plan.pdf' }, { name: 'photo.jpg' }] } })),
    t1: node('t1', 'u1', ['h1'], msg('tool', 'tool output — skip')),
    h1: node('h1', 't1', ['th1'], msg('assistant', 'hidden — skip', { meta: { is_visually_hidden_from_conversation: true } })),
    th1: node('th1', 'h1', ['a9'], Object.assign(msg('assistant', 'x'), { content: { content_type: 'thoughts', thoughts: [] } })),
    a9: node('a9', 'th1', [], Object.assign(msg('assistant', ''), { content: { content_type: 'multimodal_text', parts: [{ image: true }, 'the visible answer'] } }))
  }
};

// empty conv (docs-less) must be skipped entirely
const empty = { conversation_id: 'ee', title: 'x', create_time: 1, current_node: 'root',
  mapping: { root: node('root', null, [], null) } };

// ---- detection ----
check('detect: chatgpt shape', isChatGPTExport([branched]) === true);
check('detect: claude shape wins', isChatGPTExport([{ chat_messages: [] }, branched]) === false);
check('detect: plain junk is not chatgpt', isChatGPTExport([{ foo: 1 }]) === false);

// ---- normalize ----
const recs = normalizeChatGPT([branched, junky, empty]);
check('two records (empty skipped)', recs.length === 2, recs.length);
const b = recs[0];
check('walk-back linearizes the LIVE branch', b.docs.map(d => d.t).join('|') ===
  'first question|first answer|second question, edited|final answer', b.docs.map(d => d.t));
check('abandoned edit excluded', b.docs.every(d => d.t.indexOf('ABANDONED') < 0));
check('senders h/a alternate', b.docs.map(d => d.s).join('') === 'haha', b.docs.map(d => d.s));
check('uuid from conversation_id + source + title', b.uuid === 'cccccccc-1111-2222-3333-444444444444' &&
  b.source === 'chatgpt' && b.name === 'Branch test', [b.uuid, b.source, b.name]);
check('unix-seconds -> ISO conv dates', /^2026-07-07T/.test(b.created_at) && b.updated_at > b.created_at,
  [b.created_at, b.updated_at]);
check('doc dates are local minutes', b.docs.every(d => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.d)), b.docs.map(d => d.d));
check('msgCount = docs', b.msgCount === 4, b.msgCount);
check('schema stamped', b.schema === SCHEMA);
check('models: per-message model_slug, distinct + in order', JSON.stringify(b.models) === JSON.stringify(['gpt-4o', 'gpt-4o-mini']), b.models);
const j = recs[1];
check('junky: only real dialogue survives', j.docs.map(d => d.t).join('|') === 'real question|the visible answer', j.docs.map(d => d.t));
check('junky: uuid falls back to id, untitled name', j.uuid === 'dddddddd-1111-2222-3333-444444444444' && j.name === '(untitled)', [j.uuid, j.name]);
check('junky: attachment names harvested', JSON.stringify(j.fileNames) === JSON.stringify(['plan.pdf', 'photo.jpg']), j.fileNames);
check('junky: image part dropped, string part kept', j.docs[1].t === 'the visible answer', j.docs[1].t);
check('models: default_model_slug fallback when no per-message slug', JSON.stringify(j.models) === JSON.stringify(['gpt-4o']), j.models);

console.log('\n' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount ? 1 : 0);
