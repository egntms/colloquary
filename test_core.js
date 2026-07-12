// Core logic test: normalize conversations.json -> docs -> MiniSearch -> queries
const fs = require('fs');
const MiniSearch = require('minisearch');

// === normalize (same function that ships in the HTML) ===
function extractText(msg) {
  const parts = [];
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b && b.type === 'text' && b.text) parts.push(b.text);
    }
  }
  if (!parts.length && msg.text) parts.push(msg.text);
  return parts.join('\n').trim();
}

function normalize(conversations) {
  const docs = [];
  for (const c of conversations) {
    const msgs = c.chat_messages || [];
    let i = 0;
    for (const m of msgs) {
      const text = extractText(m);
      if (!text) continue;
      docs.push({
        id: c.uuid + ':' + i,
        convUuid: c.uuid,
        convName: c.name || '(untitled)',
        sender: m.sender,           // 'human' | 'assistant'
        date: (m.created_at || c.created_at || '').slice(0, 10),
        text
      });
      i++;
    }
  }
  return docs;
}

// === run against real data ===
console.time('parse');
const data = JSON.parse(fs.readFileSync('conversations.json', 'utf8'));
console.timeEnd('parse');

console.time('normalize');
const docs = normalize(data);
console.timeEnd('normalize');
console.log('docs:', docs.length, '| total text MB:',
  (docs.reduce((s, d) => s + d.text.length, 0) / 1e6).toFixed(1));

console.time('index');
const ms = new MiniSearch({
  fields: ['text', 'convName'],
  storeFields: ['convUuid', 'convName', 'sender', 'date'],
  searchOptions: { prefix: true, fuzzy: 0.15, boost: { convName: 2 } }
});
ms.addAll(docs);
console.timeEnd('index');

// queries Eugen knows the answers to
const docById = new Map(docs.map(d => [d.id, d]));
for (const q of ['Umeyama', 'coturn credentials', 'Rotek', 'Nonius hanger', 'ParrotAudioPlugin']) {
  console.time('q:' + q);
  const res = ms.search(q);
  console.timeEnd('q:' + q);
  const convs = [...new Set(res.map(r => r.convName))].slice(0, 3);
  console.log(`"${q}" -> ${res.length} hits | top convs: ${convs.join(' | ')}`);
  if (res[0]) {
    const d = docById.get(res[0].id);
    const idx = d.text.toLowerCase().indexOf(q.split(' ')[0].toLowerCase());
    console.log('   snippet:', d.text.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' '));
  }
}
