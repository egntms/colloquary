/* colloquary import worker v3: claude.ai export (zip/json) + Claude Code / Cowork session folders (JSONL) + ChatGPT export (v2.2) */
var SCHEMA = 3; /* v3: doc.d = 'YYYY-MM-DDTHH:MM' LOCAL time (was date-only) — powers time-spent stats */

/* ---------- Claude Code / Cowork session import ----------
   Both write the same Agent-SDK JSONL transcript format; only the folder layout differs.
   Cowork:      <space>/<project>/local_<id>.json (meta) + local_<id>/.claude/projects/<cwd>/<cliSessionId>.jsonl
   Claude Code: ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl (no meta json) */
var UUID_JSONL = /(^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
var META_JSON = /(^|\/)(local_[0-9a-f-]+)\.json$/i;
/* uploads are prefixed "<uuid>-<epoch>_name" — keep the human part */
var UPLOAD_PREFIX = /^[0-9a-f-]{36}-\d+_/i;

/* ---- session payload files (v1.21.0) ----
   A session's outputs/ + uploads/ folders hold REAL file text (deliverables, handovers, code) that
   the transcript itself never carries — dragging the sessions folder delivers them, we attach the
   text ones to their session as ty:'a' docs (green chip / open / download / searchable).
   Gating mirrors app.js (collection side); the worker re-checks so filters can't be bypassed.
   Evidence 2026-07-07 (Eugen's real tree): text worth keeping = md/py/ts/js/json/txt…; noise to
   dodge = unpacked docx/xlsx guts (105 MB xml), media, node_modules, .tmp, multi-MB data dumps. */
var PAYLOAD_PATH = /(^|\/)(local_[0-9a-f-]+)\/(outputs|uploads)\//i;
var PAYLOAD_EXT = /\.(md|txt|py|js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|html|htm|css|csv|sh|log|toml|ini|sql)$/i;
var PAYLOAD_SKIP = /(^|\/)(unpacked[^\/]*|word|xl|ppt|_rels|docProps|customXml|media|node_modules|\.git|dist|build|\.next|coverage)(\/|$)/i;
var PAYLOAD_MAX = 200 * 1024;            /* per file — bigger is a data dump, not a document */
var PAYLOAD_CONV_MAX = 2 * 1024 * 1024;  /* per session — total attached-text budget */

/* path-level payload check (no size — File may not be in hand yet); extension-less files pass
   here and get a binary sniff after reading */
function isPayloadPath(p) {
  return PAYLOAD_PATH.test(p) && !PAYLOAD_SKIP.test(p) &&
    (PAYLOAD_EXT.test(p) || p.split('/').pop().indexOf('.') === -1);
}

/* ---- transcript file recovery (v1.21.0 B2) ----
   When the agent Reads or Writes a file, its full text rides the JSONL as tool_use/tool_result —
   the only source for files OUTSIDE the session dirs (the user's repos: code, handovers, configs).
   We pair Read results + Write inputs by tool_use_id, keep the LATEST capture per path, and attach
   them like payload files. outputs/uploads paths are deliberately excluded — B1 attaches those from
   disk (real bytes beat transcript echoes). Edit/MultiEdit are partial diffs — never captured. */
var NUL_CH = String.fromCharCode(0);

/* a repo file_path worth capturing from the transcript */
function isRecoverablePath(p) {
  if (/\/(outputs|uploads)\//.test(p)) return false; /* session payloads — B1 owns them */
  if (PAYLOAD_SKIP.test(p)) return false;            /* deps / office guts / build dirs */
  return PAYLOAD_EXT.test(p) || p.split('/').pop().indexOf('.') === -1;
}

/* tool_result content -> plain text ('' when there is none, e.g. image-only results) */
function toolResultText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  var parts = [];
  for (var i = 0; i < c.length; i++) {
    if (c[i] && c[i].type === 'text' && c[i].text) parts.push(c[i].text);
  }
  return parts.join('\n');
}

/* Read results are cat -n formatted ("   12\tline"); strip the prefixes only when that shape
   dominates, so a real file that happens to contain such lines is left alone. Truncation /
   system-reminder notices appended by the harness are dropped either way. */
function stripToolReadText(t) {
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  var lines = t.split('\n'), numbered = 0, i;
  for (i = 0; i < lines.length; i++) if (/^\s*\d+\t/.test(lines[i])) numbered++;
  if (numbered && numbered >= lines.length * 0.9) {
    for (i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/^\s*\d+\t/, '');
    t = lines.join('\n');
  }
  return t;
}

/* captures (path -> {t,d,s}) -> ty:'a' docs appended after the dialogue; path-sorted for
   deterministic output; basename collisions get a parent-dir hint so both stay addressable */
function flushCaptures(captures, docs, fileNames) {
  var paths = [], p, i;
  for (p in captures) paths.push(p);
  if (!paths.length) return;
  paths.sort();
  var byBase = {};
  for (i = 0; i < paths.length; i++) {
    var b = paths[i].split('/').pop();
    byBase[b] = (byBase[b] || 0) + 1;
  }
  var budget = 0;
  for (i = 0; i < paths.length; i++) {
    p = paths[i];
    var cap = captures[p], t = cap.t;
    if (!t || t.length > PAYLOAD_MAX || t.indexOf(NUL_CH) !== -1) continue;
    if (budget + t.length > PAYLOAD_CONV_MAX) break;
    budget += t.length;
    var segs = p.split('/'), fn = segs.pop();
    if (byBase[fn] > 1 && segs.length) fn = segs.pop() + '/' + fn;
    docs.push({ s: cap.s, d: cap.d, t: t, ty: 'a', fn: fn });
    fileNames.push(fn);
  }
}

/* colloquary's own whole-archive export (backup / phone transfer): a wrapper object carrying
   already-normalized conv records. Detected on drop so we upsert them directly, never re-normalize. */
function isNativeArchive(data) {
  return !!(data && data.skillmint_archive === true && Array.isArray(data.convs));
}

/* ---- claude.ai Projects (v2.1) ----
   The export's projects/*.json carry FULL document content (docs[]{content,filename,uuid,created_at})
   but the export has NO conv->project link (proven 2026-07-07: the only "project" strings in 204 MB
   of conversations.json are file paths inside tool payloads). So Project knowledge becomes its OWN
   record per project — source:'project', docs as ty:'a' attachments: searchable, openable,
   downloadable. Empty projects are skipped (nothing to search or open). Docs deliberately UNCAPPED,
   like claude-path attachments — curated knowledge is the record's whole value. */
function normalizeProjects(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p || !p.uuid || !Array.isArray(p.docs) || !p.docs.length) continue;
    var docs = [], fileNames = [];
    for (var j = 0; j < p.docs.length; j++) {
      var doc = p.docs[j];
      if (!doc || !doc.content) continue;
      var fn = doc.filename || '(untitled doc)';
      fileNames.push(fn);
      docs.push({ s: 'h', d: localMinute(doc.created_at || p.created_at || ''), t: doc.content, ty: 'a', fn: fn });
    }
    if (!docs.length) continue;
    out.push({
      uuid: p.uuid,
      name: p.name || '(untitled project)',
      created_at: p.created_at || '',
      updated_at: p.updated_at || p.created_at || '',
      msgCount: docs.length,
      schema: SCHEMA,
      source: 'project',
      project: p.name || '',
      fileNames: fileNames,
      docs: docs
    });
  }
  return out;
}

function isoFromMs(ms) {
  var n = Number(ms);
  if (!n) return '';
  try { return new Date(n).toISOString(); } catch (e) { return ''; }
}

function isoFromSec(s) { /* ChatGPT timestamps are unix SECONDS (floats) */
  var n = Number(s);
  return n ? isoFromMs(n * 1000) : '';
}

/* ---- ChatGPT export adapter (v2.2) ----
   Same filename (conversations.json), different shape: an array of conversations, each a TREE —
   mapping = {nodeId: {id, parent, children, message}} — because edits/regenerations branch.
   The linear thread the user last saw = walk BACK from current_node to the root, then reverse
   (a naive node loop would mix abandoned branches in). Dialogue-only, like the other adapters:
   system/tool turns, hidden nodes, reasoning ('thoughts'), code-interpreter payloads and
   custom-instruction contexts are skipped. Attachment NAMES are harvested from metadata
   (the export carries no file bytes/text — same honest name-only chips as elsewhere). */
function gptText(msg) {
  var c = msg.content || {};
  var ct = c.content_type || '';
  if (ct !== 'text' && ct !== 'multimodal_text') return ''; /* thoughts/code/user_editable_context/… */
  var arr = c.parts || [], parts = [];
  for (var i = 0; i < arr.length; i++) {
    if (typeof arr[i] === 'string' && arr[i]) parts.push(arr[i]); /* non-string parts = images etc. */
  }
  return parts.join('\n').trim();
}

function isChatGPTExport(data) {
  for (var i = 0; i < data.length && i < 5; i++) {
    if (data[i] && data[i].chat_messages) return false;              /* claude export */
    if (data[i] && data[i].mapping && data[i].current_node) return true;
  }
  return false;
}

function normalizeChatGPT(data, report) {
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var c = data[i] || {};
    var map = c.mapping || {};
    var chain = [], id = c.current_node, guard = 0;
    while (id && map[id] && guard++ < 100000) { chain.push(map[id]); id = map[id].parent; }
    chain.reverse();
    var docs = [], fileNames = [], models = [], k, j;
    for (k = 0; k < chain.length; k++) {
      var m = chain[k].message;
      if (!m || !m.author) continue; /* root node carries no message */
      var role = m.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
      var atts = (m.metadata && m.metadata.attachments) || [];
      for (j = 0; j < atts.length; j++) if (atts[j] && atts[j].name) fileNames.push(atts[j].name);
      var t = gptText(m);
      if (!t) continue;
      if (role === 'assistant' && m.metadata && m.metadata.model_slug && models.indexOf(m.metadata.model_slug) < 0) models.push(m.metadata.model_slug);
      docs.push({ s: role === 'user' ? 'h' : 'a', d: localMinute(isoFromSec(m.create_time) || isoFromSec(c.create_time)), t: t });
    }
    if (!docs.length) continue;
    if (!models.length && c.default_model_slug && c.default_model_slug !== 'auto') models.push(c.default_model_slug);
    out.push({
      uuid: String(c.conversation_id || c.id || ('chatgpt-' + i)),
      name: c.title || '(untitled)',
      created_at: isoFromSec(c.create_time),
      updated_at: isoFromSec(c.update_time) || isoFromSec(c.create_time),
      msgCount: docs.length,
      schema: SCHEMA,
      source: 'chatgpt',
      models: models,
      fileNames: fileNames,
      docs: docs
    });
    if (report && i % 50 === 0) report('Extracting ChatGPT threads…', 75 + Math.round(20 * i / data.length));
  }
  return out;
}

/* UTC ISO -> 'YYYY-MM-DDTHH:MM' in the IMPORTING DEVICE's timezone (day boundaries + hour-of-day
   stats should match the user's clock, like claude.ai does). Falls back to the date part. */
function localMinute(iso) {
  var ms = Date.parse(String(iso || ''));
  if (!ms) return String(iso || '').slice(0, 10);
  var dt = new Date(ms);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
    'T' + p(dt.getHours()) + ':' + p(dt.getMinutes());
}

/* strip machine wrappers from a user turn; returns { t, files } — files = uploaded basenames */
function cleanUserText(t) {
  var files = [];
  if (/^\s*Caveat: the messages below were generated by the user while running local commands/i.test(t)) {
    return { t: '', files: files };
  }
  t = t.replace(/<uploaded_files>[\s\S]*?<\/uploaded_files>/gi, function (block) {
    var re = /<file_path>([\s\S]*?)<\/file_path>/gi, m;
    while ((m = re.exec(block)) !== null) {
      var base = m[1].trim().split('/').pop();
      files.push(base.replace(UPLOAD_PREFIX, ''));
    }
    return ' ';
  });
  t = t.replace(/<\/?scheduled-task\b[^>]*>/gi, ' ');                        /* keep the task prompt itself */
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  t = t.replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/gi, ' ');
  t = t.replace(/<local-command-std(out|err)>[\s\S]*?<\/local-command-std\1>/gi, ' ');
  return { t: t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), files: files };
}

/* one JSONL transcript -> conversation record (or null when it holds no readable dialogue) */
function normalizeSession(text, meta, uuid, path) {
  var docs = [], fileNames = [], firstTs = '', lastTs = '', summaryTitle = '', firstUser = '', models = [];
  var lastAsstId = null, sawTopLevel = false;
  var toolUses = {};  /* tool_use_id -> pending {kind:'r'|'w', path, content?} (B2) */
  var captures = {};  /* file_path -> {t, d, s} — latest capture wins (B2) */
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var o; try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    if (o.type === 'summary') { summaryTitle = o.summary || summaryTitle; continue; }
    if (o.isSidechain || o.isMeta) continue; /* subagent traffic / injected context */
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    sawTopLevel = true;
    var ts = String(o.timestamp || ''), d = localMinute(ts);
    var m = o.message || {}, c = m.content, parts = [], k;
    if (o.type === 'user') {
      if (typeof c === 'string') parts.push(c);
      else if (Array.isArray(c)) {
        for (k = 0; k < c.length; k++) {
          var ub = c[k];
          if (!ub) continue;
          if (ub.type === 'text' && ub.text) parts.push(ub.text);
          /* B2: a tool_result answering a pending Read/Write closes the capture. Write's text
             came with its tool_use; the result only confirms it happened (is_error guards both). */
          else if (ub.type === 'tool_result' && ub.tool_use_id && toolUses[ub.tool_use_id]) {
            var tu = toolUses[ub.tool_use_id];
            delete toolUses[ub.tool_use_id];
            if (!ub.is_error) {
              if (tu.kind === 'w') captures[tu.path] = { t: tu.content, d: d, s: 'a' };
              else {
                var rt = stripToolReadText(toolResultText(ub.content));
                if (rt) captures[tu.path] = { t: rt, d: d, s: 'h' };
              }
            }
          }
        }
      }
      if (!parts.length) continue; /* tool_result-only turn */
      var cu = cleanUserText(parts.join('\n'));
      for (k = 0; k < cu.files.length; k++) fileNames.push(cu.files[k]);
      if (!cu.t) continue;
      docs.push({ s: 'h', d: d, t: cu.t });
      if (!firstUser) firstUser = cu.t;
      lastAsstId = null;
    } else {
      if (m.model && m.model !== '<synthetic>' && models.indexOf(m.model) < 0) models.push(m.model);
      if (Array.isArray(c)) {
        for (k = 0; k < c.length; k++) {
          var ab = c[k];
          if (!ab) continue;
          /* text only: thinking + tool_use are deliberately not indexed (117 MB-noise lesson) —
             but B2 REMEMBERS Read/Write tool_uses on recoverable paths so the matching
             tool_result can turn them into file captures (never indexed as dialogue) */
          if (ab.type === 'text' && ab.text && ab.text.trim()) parts.push(ab.text);
          else if (ab.type === 'tool_use' && ab.id && ab.input && typeof ab.input.file_path === 'string' &&
                   isRecoverablePath(ab.input.file_path)) {
            if (ab.name === 'Read') toolUses[ab.id] = { kind: 'r', path: ab.input.file_path };
            else if (ab.name === 'Write' && typeof ab.input.content === 'string')
              toolUses[ab.id] = { kind: 'w', path: ab.input.file_path, content: ab.input.content };
          }
        }
      }
      if (!parts.length) continue;
      var t2 = parts.join('\n').trim();
      /* streaming splits ONE assistant message over several lines sharing message.id — merge */
      if (m.id && m.id === lastAsstId && docs.length && docs[docs.length - 1].s === 'a') {
        docs[docs.length - 1].t += '\n' + t2;
      } else {
        docs.push({ s: 'a', d: d, t: t2 });
      }
      lastAsstId = m.id || null;
    }
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
  }
  if (!docs.length || !sawTopLevel) return null;
  var dialogueCount = docs.length;
  flushCaptures(captures, docs, fileNames); /* B2: recovered repo files ride after the dialogue */
  (meta && meta.fsDetectedFiles || []).forEach(function (f) {
    if (f && f.fileName) fileNames.push(f.fileName);
  });
  return {
    uuid: uuid,
    name: (meta && meta.title) || summaryTitle || deriveSessionName(path, firstUser),
    created_at: (meta && isoFromMs(meta.createdAt)) || firstTs,
    updated_at: (meta && isoFromMs(meta.lastActivityAt)) || lastTs || firstTs,
    msgCount: dialogueCount,
    schema: SCHEMA,
    source: meta ? 'cowork' : 'code',
    project: deriveProject(meta, path),
    models: models,
    fileNames: fileNames,
    docs: docs
  };
}

/* last humane segment of the munged cwd dir: "-Users-eugen-fits" -> "fits" */
function mungedTail(path) {
  var segs = path.split('/');
  var proj = segs.length > 1 ? segs[segs.length - 2] : '';
  return proj.split('-').filter(Boolean).pop() || '';
}

function deriveSessionName(path, firstUser) {
  var tail = mungedTail(path);
  var head = (firstUser || '').replace(/\s+/g, ' ').slice(0, 60);
  return (tail && head) ? tail + ': ' + head : (head || tail || '(untitled session)');
}

/* folder tag for grouping: Cowork = basename of the user-selected folder; Code = cwd tail */
function deriveProject(meta, path) {
  if (meta) {
    var f = (meta.userSelectedFolders || [])[0];
    return f ? (String(f).replace(/\/+$/, '').split('/').pop() || '') : '';
  }
  return mungedTail(path);
}

function importSessions(entries, report, fail, done) {
  var metaEnts = [], transcripts = [], payloads = [], i;
  for (i = 0; i < entries.length; i++) {
    var p = entries[i].path || entries[i].file.name;
    if (META_JSON.test(p)) metaEnts.push(entries[i]);
    else if (UUID_JSONL.test(p)) transcripts.push(entries[i]);
    else if (isPayloadPath(p)) payloads.push(entries[i]);
  }
  /* deterministic attach order regardless of directory-walk order */
  payloads.sort(function (a, b) { return (a.path || a.file.name) < (b.path || b.file.name) ? -1 : 1; });
  report('Reading ' + metaEnts.length + ' session records…', 5);
  var metaById = {}; /* cliSessionId -> parsed meta */
  var cliByDir = {}; /* "local_<id>" dir -> cliSessionId (payload files live under the dir, docs under the cli uuid) */
  var mi = 0;
  function nextMeta() {
    if (mi >= metaEnts.length) { processTranscripts(); return; }
    var ent = metaEnts[mi++];
    ent.file.text().then(function (txt) {
      try {
        var m = JSON.parse(txt);
        if (m && m.cliSessionId) {
          metaById[String(m.cliSessionId).toLowerCase()] = m;
          var dm = (ent.path || ent.file.name).match(META_JSON);
          if (dm) cliByDir[dm[2].toLowerCase()] = String(m.cliSessionId).toLowerCase();
        }
      } catch (e) { /* not a session meta — ignore */ }
      nextMeta();
    }, function () { nextMeta(); });
  }
  var convs = [], skipped = 0, ti = 0;
  var coworkMode = false;
  function processTranscripts() {
    coworkMode = Object.keys(metaById).length > 0;
    nextTranscript();
  }
  function nextTranscript() {
    if (ti >= transcripts.length) {
      if (!convs.length) { fail('No readable sessions found. Pick your ~/.claude folder (Claude Code) or the "local-agent-mode-sessions" folder (Cowork).'); return; }
      attachPayloads(function (files) { done(convs, skipped, files); });
      return;
    }
    var ent = transcripts[ti++];
    var path = ent.path || ent.file.name;
    var uuid = (path.match(UUID_JSONL) || [])[2];
    var meta = uuid ? metaById[uuid.toLowerCase()] : null;
    /* in a Cowork tree, jsonl files without a paired meta are subagent or superseded sessions */
    if (coworkMode && !meta) { skipped++; nextTranscript(); return; }
    report('Reading sessions… ' + ti + '/' + transcripts.length, 10 + Math.round(80 * ti / transcripts.length));
    ent.file.text().then(function (txt) {
      var conv = normalizeSession(txt, meta, uuid.toLowerCase(), path);
      if (conv) convs.push(conv); else skipped++;
      nextTranscript();
    }, function () { skipped++; nextTranscript(); });
  }
  /* v1.21.0: attach outputs/uploads text files to their session conv as ty:'a' docs.
     Skips: unmapped dirs (subagent/superseded), empty/oversize files, NUL-carrying (binary
     despite the extension), duplicates (same name+size in one session), past-budget sessions. */
  function attachPayloads(cb) {
    if (!payloads.length || !convs.length) { cb(0); return; }
    var byUuid = {};
    var budget = {}, seen = {}, attached = 0, pi = 0;
    for (var ci = 0; ci < convs.length; ci++) {
      var cv = convs[ci];
      byUuid[cv.uuid] = cv;
      /* B2 transcript captures are already on the conv — seed dedupe keys + the byte budget so
         disk + transcript sources share one per-session ceiling and can't double-attach a file */
      for (var di = 0; di < cv.docs.length; di++) {
        var dd = cv.docs[di];
        if (dd.ty === 'a') {
          seen[cv.uuid + '|' + dd.fn + '|' + dd.t.length] = 1;
          budget[cv.uuid] = (budget[cv.uuid] || 0) + dd.t.length;
        }
      }
    }
    function next() {
      if (pi >= payloads.length) { cb(attached); return; }
      var ent = payloads[pi++];
      if (pi % 25 === 1) report('Attaching session files… ' + pi + '/' + payloads.length, 92 + Math.round(7 * pi / payloads.length));
      var p = ent.path || ent.file.name;
      var dm = p.match(PAYLOAD_PATH);
      var conv = dm ? byUuid[cliByDir[dm[2].toLowerCase()]] : null;
      var f = ent.file;
      if (!conv || !f.size || f.size > PAYLOAD_MAX || (budget[conv.uuid] || 0) >= PAYLOAD_CONV_MAX) { next(); return; }
      f.text().then(function (t) {
        if (t.indexOf('\u0000') === -1) { /* real text never carries NUL */
          var fn = p.split('/').pop().replace(UPLOAD_PREFIX, '');
          var k = conv.uuid + '|' + fn + '|' + t.length;
          if (!seen[k]) {
            seen[k] = 1;
            budget[conv.uuid] = (budget[conv.uuid] || 0) + t.length;
            /* sender = who produced the file: uploads/ = the user's, outputs/ = Claude's work —
               keeps Stats you-vs-Claude words and the token coach honest (msAuthored skips ty:'a'
               anyway, so neither pollutes the me.skill voice) */
            var sender = dm[3].toLowerCase() === 'uploads' ? 'h' : 'a';
            conv.docs.push({ s: sender, d: localMinute(isoFromMs(f.lastModified)), t: t, ty: 'a', fn: fn });
            conv.fileNames.push(fn);
            attached++;
          }
        }
        next();
      }, function () { next(); });
    }
    next();
  }
  nextMeta();
}

self.onmessage = function (e) {
  if (e.data && e.data.sessionFiles) {
    importSessions(
      e.data.sessionFiles,
      function (stage, pct) { self.postMessage({ type: 'progress', stage: stage, pct: pct }); },
      function (msg) { self.postMessage({ type: 'error', message: msg }); },
      function (convs, skipped, files) { self.postMessage({ type: 'done', convs: convs, skipped: skipped, files: files }); }
    );
    return;
  }
  var file = e.data.file;
  var report = function (stage, pct) { self.postMessage({ type: 'progress', stage: stage, pct: pct }); };
  var fail = function (msg) { self.postMessage({ type: 'error', message: msg }); };

  report('Reading file…', 5);

  file.arrayBuffer().then(function (buf) {
    try {
      var jsonText = null;
      var name = (file.name || '').toLowerCase();

      var projBytes = []; /* v2.1: projects/*.json ride the same export zip */
      if (name.endsWith('.zip') || isZip(buf)) {
        report('Unzipping…', 15);
        var files = fflate.unzipSync(new Uint8Array(buf), {
          filter: function (f) { return /(^|\/)((conversations|skillmint-archive|colloquary-archive)\.json|projects\/[^\/]+\.json)$/.test(f.name); }
        });
        var keys = Object.keys(files), key = null;
        for (var ki = 0; ki < keys.length; ki++) {
          if (/(^|\/)projects\//.test(keys[ki])) projBytes.push(files[keys[ki]]);
          else key = keys[ki];
        }
        if (!key) { fail('No conversations.json (Claude export) or skillmint-archive.json / colloquary-archive.json (colloquary backup) found inside this zip.'); return; }
        report('Decoding…', 30);
        jsonText = new TextDecoder().decode(files[key]);
      } else {
        report('Decoding…', 20);
        jsonText = new TextDecoder().decode(new Uint8Array(buf));
      }

      report('Parsing JSON (this is the slow part)…', 45);
      var data = JSON.parse(jsonText);
      jsonText = null;

      /* colloquary's own archive backup — records are already normalized SCHEMA-N convs; upsert
         them directly (no re-normalization, no SCHEMA bump). This is how Code/Cowork chats reach a phone. */
      if (isNativeArchive(data)) {
        report('Done', 100);
        self.postMessage({ type: 'done', convs: data.convs, native: true });
        return;
      }

      if (!Array.isArray(data)) { fail('Unexpected format: expected an array of conversations.'); return; }

      /* v2.2: a ChatGPT export uses the SAME filename with a tree shape — route by shape, not name */
      if (isChatGPTExport(data)) {
        report('Extracting ChatGPT threads…', 75);
        var gconvs = normalizeChatGPT(data, report);
        if (!gconvs.length) { fail('This looks like a ChatGPT export, but no readable conversations were found in it.'); return; }
        report('Done', 100);
        self.postMessage({ type: 'done', convs: gconvs });
        return;
      }

      report('Extracting text + attachments…', 75);
      var convs = [];
      for (var i = 0; i < data.length; i++) {
        var c = data[i];
        var msgs = c.chat_messages || [];
        var docs = [];
        var fileNames = [];
        for (var j = 0; j < msgs.length; j++) {
          var m = msgs[j];
          var d = localMinute(m.created_at || c.created_at || '');
          var s = m.sender === 'human' ? 'h' : 'a';
          var t = extractText(m);
          if (t) docs.push({ s: s, d: d, t: t });
          var atts = m.attachments || [];
          for (var k = 0; k < atts.length; k++) {
            var a = atts[k];
            var fn = a.file_name || '(pasted text)';
            fileNames.push(fn);
            if (a.extracted_content) {
              docs.push({ s: s, d: d, t: a.extracted_content, ty: 'a', fn: fn });
            }
          }
          var fls = m.files || [];
          for (var k2 = 0; k2 < fls.length; k2++) {
            if (fls[k2] && fls[k2].file_name) fileNames.push(fls[k2].file_name);
          }
        }
        convs.push({
          uuid: c.uuid,
          name: c.name || '(untitled)',
          created_at: c.created_at || '',
          updated_at: c.updated_at || c.created_at || '',
          msgCount: msgs.length,
          schema: SCHEMA,
          fileNames: fileNames,
          docs: docs
        });
        if (i % 20 === 0) report('Extracting text + attachments…', 75 + Math.round(20 * i / data.length));
      }

      /* v2.1: Project knowledge — one record per non-empty project (see normalizeProjects) */
      if (projBytes.length) {
        report('Reading project knowledge…', 97);
        var projs = [];
        for (var pj = 0; pj < projBytes.length; pj++) {
          try { projs.push(JSON.parse(new TextDecoder().decode(projBytes[pj]))); } catch (e) { /* not a project file — ignore */ }
        }
        var pconvs = normalizeProjects(projs);
        for (pj = 0; pj < pconvs.length; pj++) convs.push(pconvs[pj]);
      }

      report('Done', 100);
      self.postMessage({ type: 'done', convs: convs });
    } catch (err) {
      fail('Import failed: ' + (err && err.message ? err.message : String(err)));
    }
  }).catch(function (err) {
    fail('Could not read file: ' + (err && err.message ? err.message : String(err)));
  });

  function isZip(buf) {
    var b = new Uint8Array(buf, 0, 4);
    return b[0] === 0x50 && b[1] === 0x4b;
  }

  function extractText(msg) {
    var parts = [];
    if (Array.isArray(msg.content)) {
      for (var k = 0; k < msg.content.length; k++) {
        var b = msg.content[k];
        if (b && b.type === 'text' && b.text) parts.push(b.text);
      }
    }
    if (!parts.length && msg.text) parts.push(msg.text);
    return parts.join('\n').trim();
  }
};
