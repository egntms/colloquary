/* colloquary main app v2: operators, attachments, recency ranking, recent searches */
(function () {
  'use strict';

  var SCHEMA = 3; /* v3: doc.d carries local 'YYYY-MM-DDTHH:MM' — time-spent/hour stats; date ops unaffected (prefix compare) */
  /* display helpers: docs may be date-only (pre-v3) or datetime */
  function dDay(d) { return (d || '').slice(0, 10); }
  function dNice(d) { return (d || '').replace('T', ' '); }
  var $ = function (sel) { return document.querySelector(sel); };
  /* srcTabs: MULTI-select source chips (v1.26.0, Eugen: "permit more than one chip") — empty = all */
  var state = { convs: new Map(), index: null, query: '', sort: 'relevance', sender: '', srcTabs: [], dateMin: 0, dateMax: 1, recent: [], matchedTerms: [], dossier: null, semOn: false, route: null, pins: [], pinnedSearches: [], pinView: false };
  function srcTabSet() { if (!state.srcTabs.length) return null; var s = {}; state.srcTabs.forEach(function (k) { s[k] = 1; }); return s; }

  /* ---------- Pins (conversations + searches) — persisted in the meta store, no schema change ---------- */
  function isPinned(uuid) { return state.pins.indexOf(uuid) >= 0; }
  function pinBtn(c) {
    var on = isPinned(c.uuid);
    return '<button class="pin' + (on ? ' on' : '') + '" data-pin="' + esc(c.uuid) + '" aria-pressed="' + on +
      '" title="' + (on ? 'Unpin' : 'Pin to top') + '" aria-label="' + (on ? 'Unpin conversation' : 'Pin conversation') + '">📌</button>';
  }
  function togglePin(uuid) {
    if (!uuid) return;
    var at = state.pins.indexOf(uuid);
    if (at >= 0) state.pins.splice(at, 1); else state.pins.unshift(uuid);
    if (!state.pins.length) state.pinView = false; /* no pins left → drop the pinned view */
    setMeta('pinnedConvs', state.pins);
    renderStats();      /* refresh the 📌 tab (count / existence) */
    updateReaderPin();  /* reader header button, if a conversation is open */
    runSearch();        /* re-render browse/results incl. the pinned section */
  }
  function updateReaderPin() {
    var b = $('#reader-pin'); if (!b) return;
    var c = state.readerConv;
    if (!c || !c.uuid || c.uuid.indexOf('demo-') === 0) { b.style.display = 'none'; return; }
    var on = isPinned(c.uuid);
    b.style.display = '';
    b.classList.toggle('on', on);
    b.textContent = on ? '📌 Pinned' : '📌 Pin';
    b.title = on ? 'Unpin this conversation' : 'Pin this conversation to the top of your list';
  }
  function togglePinSearch(q) {
    if (!q) return;
    var at = state.pinnedSearches.indexOf(q);
    if (at >= 0) state.pinnedSearches.splice(at, 1); else state.pinnedSearches.unshift(q);
    setMeta('pinnedSearches', state.pinnedSearches);
    renderRecent();
  }

  /* ---------- IndexedDB ---------- */
  var DB_NAME = 'chatalog', DB_VER = 1, db = null;

  function openDB() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'uuid' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function loadAll() {
    return new Promise(function (res, rej) {
      var out = [];
      var tx = db.transaction('conversations', 'readonly');
      tx.objectStore('conversations').openCursor().onsuccess = function (e) {
        var cur = e.target.result;
        if (cur) { out.push(cur.value); cur.continue(); } else res(out);
      };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  function upsertConvs(convs) {
    return new Promise(function (res, rej) {
      var added = 0, updated = 0, unchanged = 0;
      var tx = db.transaction('conversations', 'readwrite');
      var store = tx.objectStore('conversations');
      convs.forEach(function (c) {
        var existing = state.convs.get(c.uuid);
        if (!existing) { added++; store.put(c); state.convs.set(c.uuid, c); }
        else if (existing.schema !== c.schema || existing.updated_at !== c.updated_at || existing.docs.length !== c.docs.length ||
                 (existing.project || '') !== (c.project || '') ||
                 ((c.models && c.models.length) && !(existing.models && existing.models.length))) { /* re-drag backfills folder tags (v1.11.0) + models (v1.35.0) */
          updated++; store.put(c); state.convs.set(c.uuid, c);
        } else unchanged++;
      });
      tx.oncomplete = function () { res({ added: added, updated: updated, unchanged: unchanged }); };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  function setMeta(key, value) {
    var tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: key, value: value });
  }

  function getMeta(key) {
    return new Promise(function (res) {
      var tx = db.transaction('meta', 'readonly');
      var rq = tx.objectStore('meta').get(key);
      rq.onsuccess = function () { res(rq.result ? rq.result.value : null); };
      rq.onerror = function () { res(null); };
    });
  }

  function clearAll() {
    return new Promise(function (res) {
      var tx = db.transaction(['conversations', 'meta'], 'readwrite');
      tx.objectStore('conversations').clear();
      tx.objectStore('meta').clear();
      tx.oncomplete = function () { state.convs.clear(); state.index = null; state.recent = []; state.pins = []; state.pinnedSearches = []; state.pinView = false; res(); };
    });
  }

  /* ---------- Index ---------- */
  var APP_VERSION = '1.55.0'; /* shown in the footer + the diagnostic report — bump per release */
  /* the public mirror (AGPL-3.0). It is the PROOF link for the local-only claim, not a badge:
     the served file IS the source (unminified), so "read it yourself" is a real invitation. */
  var SRC_URL = 'https://github.com/egntms/colloquary';
  var INDEX_VERSION = 2; /* bump whenever index options or doc selection change — invalidates the cache */

  /* strip diacritics so `sapa` finds `Șapa`; 1:1 char mapping keeps positions aligned */
  function fold(s) {
    try { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { return s; }
  }

  function indexOptions() {
    var pt = function (term) { return fold(term.toLowerCase()); };
    return {
      fields: ['text', 'convName', 'fn'],
      storeFields: ['convUuid', 'sender', 'date', 'ty', 'fn'],
      processTerm: pt,
      searchOptions: {
        combineWith: 'AND',
        processTerm: pt,
        prefix: function (term) { return term.length >= 3; },
        fuzzy: function (term) { return term.length >= 5 ? 0.15 : false; },
        boost: { convName: 2, fn: 2.5 }
      }
    };
  }

  function hashStr(s) {
    var h = 5381, i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  function dataStamp() {
    var n = 0, maxU = '';
    state.convs.forEach(function (c) { n += c.docs.length; if ((c.updated_at || '') > maxU) maxU = c.updated_at || ''; });
    return INDEX_VERSION + ':' + SCHEMA + ':' + state.convs.size + ':' + n + ':' + maxU;
  }

  function buildIndex() {
    var ms = new MiniSearch(indexOptions());
    var docs = [];
    var seenAtt = {}; /* identical attachments pasted into many chats are indexed once */
    var minD = Infinity, maxD = -Infinity;
    state.convs.forEach(function (c) {
      for (var i = 0; i < c.docs.length; i++) {
        var d = c.docs[i];
        var ms_ = Date.parse(d.d || '') || 0;
        if (ms_) { if (ms_ < minD) minD = ms_; if (ms_ > maxD) maxD = ms_; }
        if (d.ty === 'a') {
          var k = hashStr((d.fn || '') + '|' + d.t);
          if (seenAtt[k]) continue;
          seenAtt[k] = 1;
        }
        docs.push({
          id: c.uuid + ':' + i,
          convUuid: c.uuid,
          convName: c.name,
          sender: d.s,
          date: d.d,
          ty: d.ty || 'm',
          fn: d.fn || '',
          text: d.t
        });
      }
    });
    ms.addAll(docs);
    state.index = ms;
    state.dateMin = isFinite(minD) ? minD : 0;
    state.dateMax = isFinite(maxD) && maxD > state.dateMin ? maxD : state.dateMin + 1;
  }

  /* serialized-index cache: page load goes from ~5 s rebuild to a fast JSON parse */
  function saveIndexCacheSoon(stamp) {
    setTimeout(function () {
      try {
        setMeta('indexCache', { stamp: stamp, json: JSON.stringify(state.index), dateMin: state.dateMin, dateMax: state.dateMax });
      } catch (e) { /* quota or serialization failure — cache is optional */ }
    }, 400);
  }

  function rebuildIndex() {
    buildIndex();
    saveIndexCacheSoon(dataStamp());
  }

  function ensureIndex() {
    var stamp = dataStamp();
    return getMeta('indexCache').then(function (c) {
      if (c && c.stamp === stamp && c.json && MiniSearch.loadJSON) {
        try {
          state.index = MiniSearch.loadJSON(c.json, indexOptions());
          state.dateMin = c.dateMin; state.dateMax = c.dateMax;
          return;
        } catch (e) { /* stale/corrupt cache — rebuild below */ }
      }
      buildIndex();
      saveIndexCacheSoon(stamp);
    });
  }

  /* ---------- Query parsing (mail-style operators) ---------- */
  /* accepts 2026, 2026-03, 2026.03, 2026/03/15, 05.06.2026 (dd.mm.yyyy), 2026-6-5 */
  function normalizeDate(val) {
    var v = val.replace(/[.\/]/g, '-').replace(/-+$/, '');
    var m = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);          /* dd-mm-yyyy -> yyyy-mm-dd */
    if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
    m = v.match(/^(\d{1,2})-(\d{4})$/);                          /* mm-yyyy -> yyyy-mm */
    if (m) return m[2] + '-' + pad2(m[1]);
    m = v.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);     /* yyyy[-m[-d]] */
    if (m) return m[1] + (m[2] ? '-' + pad2(m[2]) : '') + (m[3] ? '-' + pad2(m[3]) : '');
    return v;
  }
  function pad2(n) { return (n.length === 1 ? '0' : '') + n; }

  function parseQuery(raw) {
    var q = { terms: [], phrases: [], excludes: [], from: null, after: null, before: null, on: null, chat: null, file: null, hasAtt: false, source: null, folder: null };
    /* operators accept quoted values (folder:"my project", chat:"long title") */
    var re = /([a-zA-Z]+):"([^"]*)"|"([^"]*)"|(\S+)/g, m;
    while ((m = re.exec(raw)) !== null) {
      if (m[3] !== undefined) { if (m[3].trim()) q.phrases.push(m[3].trim()); continue; }
      /* key/val MUST be reset every iteration — `var` is function-scoped, so a stale key from a
         previous operator token swallowed every later plain term (v1.11.2 fix, same family as v1.7.1) */
      var key = undefined, val = undefined;
      if (m[1] !== undefined) { key = m[1].toLowerCase(); val = m[2].toLowerCase(); }
      else {
        var tok = m[4];
        var op = tok.match(/^(from|after|before|on|chat|in|file|has|source|folder|project):(.*)$/i);
        if (op) { key = op[1].toLowerCase(); val = op[2].toLowerCase(); }
      }
      if (key !== undefined) {
        if (!/^(from|after|before|on|chat|in|file|has|source|folder|project)$/.test(key)) { q.terms.push(m[0]); continue; }
        if (!val) continue;
        if (key === 'from') q.from = /^(me|you|human|eu)/.test(val) ? 'h' : 'a';
        else if (key === 'source') q.source = /^cow/.test(val) ? 'cowork' : (/^cod/.test(val) ? 'code' : (/^pro/.test(val) ? 'project' : (/^(chat|gpt|oa|openai)/.test(val) ? 'chatgpt' : 'claude')));
        else if (key === 'folder' || key === 'project') q.folder = val;
        else if (key === 'after') q.after = normalizeDate(val);
        else if (key === 'before') q.before = normalizeDate(val);
        else if (key === 'on') q.on = normalizeDate(val);
        else if (key === 'chat' || key === 'in') q.chat = val;
        else if (key === 'file') { q.file = val; q.hasAtt = true; }
        else if (key === 'has') q.hasAtt = /att|file|doc/.test(val);
        continue;
      }
      if (tok === 'AND') continue; /* AND is the default; accept it explicitly */
      if (tok.length > 1 && tok[0] === '-') { q.excludes.push(tok.slice(1).toLowerCase()); continue; }
      if (!/[a-z0-9\u00C0-\u024F]/i.test(tok)) continue; /* drop stray punctuation like a lone dash */
      q.terms.push(tok);
    }
    return q;
  }

  function parseQueryGroups(raw) {
    return raw.split(/\s+OR\s+/).map(parseQuery);
  }

  /* ---------- Query router (v1.30): natural-language analytics questions ----------
     Eugen's own idea, validated on his real archive: half his queries were aggregates
     ("how many invoices chats?", "câte ore la proiect?") that TEXT RETRIEVAL cannot
     answer but the Stats machinery already can. routeQuery is a CONSERVATIVE classifier —
     it returns kind:'analytics' only for high-confidence question shapes (leading how
     many / how much / how long / how often / when did — EN — or câte / cât / când — RO —
     plus an intent cue, and NO search operators or quotes). Everything else returns
     kind:'search' and search stays byte-for-byte pre-v1.30. The subject (question minus
     scaffolding) is searched normally and the answer is computed from the very
     conversations that search matches, so the strip's numbers equal what renders below.
     No LLM: the paraphrase-vs-exact half of the original three-way idea is already the
     ≈ hybrid toggle; this is the analytics branch. Pure + extractable (test_router.js). */

  /* period phrases -> an inclusive {after,before} YYYY-MM-DD window + a human label.
     `now` is injectable so tests are deterministic. Returns null when no period is found. */
  function parsePeriod(raw, now) {
    now = now || new Date();
    var s = ' ' + raw.toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var fmt = function (dt) { return dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate()); };
    var monthWin = function (y, m) { return { after: y + '-' + p2(m + 1) + '-01', before: y + '-' + p2(m + 1) + '-' + p2(new Date(y, m + 1, 0).getDate()) }; };
    /* single-day windows first — "yesterday"/"today" are dates, not topics (else the subject
       becomes the literal word and search hunts for it). */
    if (/ (yesterday|ieri) /.test(s)) { var yd = new Date(now); yd.setDate(yd.getDate() - 1); return { after: fmt(yd), before: fmt(yd), label: 'yesterday (' + fmt(yd) + ')' }; }
    if (/ (today|azi|ast[ăa]zi) /.test(s)) { return { after: fmt(now), before: fmt(now), label: 'today (' + fmt(now) + ')' }; }
    if (/ (last|past|previous) month | luna (trecut[ăa]|precedent[ăa]) /.test(s)) {
      var lm = new Date(now.getFullYear(), now.getMonth() - 1, 1), w = monthWin(lm.getFullYear(), lm.getMonth());
      return { after: w.after, before: w.before, label: 'last month (' + w.after.slice(0, 7) + ')' };
    }
    if (/ this month | luna (aceasta|asta|curent[ăa]) /.test(s)) {
      var w2 = monthWin(now.getFullYear(), now.getMonth());
      return { after: w2.after, before: w2.before, label: 'this month (' + w2.after.slice(0, 7) + ')' };
    }
    if (/ (last|past|previous) week | s[ăa]pt[ăa]m[âa]na trecut[ăa] /.test(s)) {
      var d = new Date(now); d.setHours(0, 0, 0, 0);
      var mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
      var sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { after: fmt(mon), before: fmt(sun), label: 'last week (' + fmt(mon) + ' → ' + fmt(sun) + ')' };
    }
    if (/ this week | s[ăa]pt[ăa]m[âa]na (aceasta|asta|curent[ăa]) /.test(s)) {
      var d2 = new Date(now); d2.setHours(0, 0, 0, 0);
      var mon2 = new Date(d2); mon2.setDate(d2.getDate() - ((d2.getDay() + 6) % 7));
      return { after: fmt(mon2), before: fmt(d2), label: 'this week' };
    }
    if (/ (last|past|previous) year | anul trecut /.test(s)) {
      var ly = now.getFullYear() - 1;
      return { after: ly + '-01-01', before: ly + '-12-31', label: '' + ly };
    }
    if (/ this year | anul (acesta|asta|curent) /.test(s)) {
      var ty = now.getFullYear();
      return { after: ty + '-01-01', before: ty + '-12-31', label: '' + ty };
    }
    /* named month (+ optional year). "mai" (RO May) is deliberately omitted — it collides with
       the everyday RO word "mai" (more/still), a false-positive magnet. */
    var MON = { jan: 0, january: 0, ian: 0, ianuarie: 0, feb: 1, february: 1, februarie: 1, mar: 2, march: 2, martie: 2,
      apr: 3, april: 3, aprilie: 3, may: 4, jun: 5, june: 5, iunie: 5, jul: 6, july: 6, iulie: 6, aug: 7, august: 7,
      sep: 8, sept: 8, september: 8, septembrie: 8, oct: 9, october: 9, octombrie: 9, nov: 10, november: 10, noiembrie: 10,
      dec: 11, december: 11, decembrie: 11 };
    for (var name in MON) {
      var m = s.match(new RegExp(' ' + name + '( \\d{4})? ')); /* the space before the year MUST be inside the optional group */
      if (m) {
        var mi = MON[name], yr = m[1] ? parseInt(m[1], 10) : (mi <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1);
        var w3 = monthWin(yr, mi);
        return { after: w3.after, before: w3.before, label: name.charAt(0).toUpperCase() + name.slice(1) + ' ' + yr };
      }
    }
    var y4 = s.match(/ (20\d{2}) /);
    if (y4) return { after: y4[1] + '-01-01', before: y4[1] + '-12-31', label: y4[1] };
    return null;
  }

  /* returns {kind:'analytics', intent, subject, period, raw} or {kind:'search'}.
     intent ∈ count | time | firstlast | activity. subject may be '' (whole-archive). */
  function routeQuery(raw, now) {
    var s = (raw || '').trim();
    if (!s) return { kind: 'search' };
    /* deliberate power-searches opt out: field operators, quoted phrases, or a leading exclude */
    if (/(^|\s)(from|after|before|on|chat|in|file|has|source|folder|project):/i.test(s)) return { kind: 'search' };
    if (s.indexOf('"') >= 0) return { kind: 'search' };
    var sl = s.toLowerCase();
    /* procedural how-to / how-does is a CONTENT search, never an aggregate */
    if (/^\s*how\s+(to|do|does|did|can|could|should|would|is|are|was|were)\b/.test(sl)) return { kind: 'search' };

    var q = ' ' + sl.replace(/\s+/g, ' ') + ' ';
    var period = parsePeriod(s, now);
    var lead = /^\s*(roughly |approximately |about |around |so |ok |hey |,\s*)*/;
    /* RO stems are diacritic-safe substrings — "conversații" is conversa+ț, so an ASCII \bconversat\b
       never matches; match the pre-diacritic stem instead. EN keeps word boundaries. */
    var COUNTABLE = /\b(chats?|conversations?|convos?|messages?|msgs?|times|threads?|sessions?|discussions?|questions?)\b|chat-uri|chaturi|conversa[țt]|discu[țt]|mesaj|[îi]ntreb/i;

    var intent = null;
    if (/\bhow (much time|many hours)\b/.test(q) || /\bhow long (did|have) i (spen|work|took|take)/.test(q) ||
        /\btime (i )?spen/.test(q) || /\bc[âa]te ore\b/.test(q) || /\bc[âa]t timp\b/.test(q)) intent = 'time';
    else if ((new RegExp(lead.source + 'when (did|was|were|have|has)\\b').test(sl) && /\b(i|my|me|first|last|start(ed)?|begin|began|ever)\b/.test(q)) ||
        /\bc[âa]nd (am|ai|a |mi|s-|au|le)\b/.test(q) || /\bc[âa]nd\b.*\b(prima|ultima|[îi]nceput|inceput|terminat|start)/.test(q)) intent = 'firstlast';
    else if (/\bhow (often|frequently)\b/.test(q) || /\bhow active (was|were|am) i\b/.test(q) ||
        /\bhow much (did|do|have) i (use|chat|talk)\b/.test(q) || /\bc[âa]t de (des|frecvent)\b/.test(q)) intent = 'activity';
    else if ((new RegExp(lead.source + 'how many\\b').test(sl) || /\bc[âa]te\b|\bc[âa][țt]i\b|\bde c[âa]te ori\b/.test(q)) &&
        (COUNTABLE.test(q) || period)) intent = 'count';

    if (!intent) return { kind: 'search' };

    /* subject = the question stripped of scaffolding vocabulary, period words and punctuation */
    var SCAFFOLD = {
      how: 1, many: 1, much: 1, long: 1, often: 1, frequently: 1, active: 1, time: 1, times: 1, hours: 1, hour: 1,
      when: 1, did: 1, do: 1, does: 1, have: 1, has: 1, had: 1, i: 1, my: 1, me: 1, the: 1, a: 1, an: 1, was: 1, were: 1,
      is: 1, are: 1, been: 1, get: 1, got: 1, there: 1, roughly: 1, approximately: 1, about: 1, around: 1, so: 1, ok: 1, hey: 1,
      chats: 1, chat: 1, 'chat-uri': 1, chaturi: 1, conversation: 1, conversations: 1, convo: 1, convos: 1, discussion: 1, discussions: 1,
      message: 1, messages: 1, msg: 1, msgs: 1, thread: 1, threads: 1, session: 1, sessions: 1, day: 1, days: 1, question: 1, questions: 1,
      talk: 1, talked: 1, talking: 1, work: 1, worked: 1, working: 1, spend: 1, spent: 1, use: 1, used: 1, using: 1, send: 1, sent: 1,
      discuss: 1, discussed: 1, mention: 1, mentioned: 1, ask: 1, asked: 1, write: 1, wrote: 1, said: 1, say: 1, chatted: 1, chatting: 1,
      first: 1, last: 1, ever: 1, start: 1, started: 1, begin: 1, began: 1, on: 1, with: 1, regarding: 1, for: 1, of: 1, to: 1, and: 1, in: 1, at: 1, total: 1,
      ore: 1, ora: 1, timp: 1, conversatii: 1, 'conversații': 1, mesaje: 1, discutii: 1, 'discuții': 1, discutie: 1, 'discuție': 1,
      vorbit: 1, lucrat: 1, folosit: 1, discutat: 1, 'început': 1, inceput: 1, terminat: 1, prima: 1, ultima: 1, oara: 1, 'oară': 1, dat: 1, ori: 1, avut: 1,
      la: 1, despre: 1, pe: 1, cu: 1, din: 1, de: 1, am: 1, ai: 1, mi: 1, cand: 1, 'când': 1, 'câte': 1, cate: 1, 'câți': 1, cati: 1, 'cât': 1, cat: 1, des: 1
    };
    var PERIODW = /^(yesterday|today|ieri|azi|ast[ăa]zi|last|past|previous|this|next|month|week|year|luna|saptamana|s[ăa]pt[ăa]m[âa]na|anul|trecut[ăa]?|precedent[ăa]?|aceasta|asta|acesta|curent[ăa]?|jan(uary)?|ian(uarie)?|feb(ruary|ruarie)?|mar(ch|tie)?|apr(il|ilie)?|may|jun(e|ie)?|iunie|jul(y)?|iulie|aug(ust)?|sep(t|tember|tembrie)?|oct(ober|ombrie)?|nov(ember|embrie)?|dec(ember|embrie)?|20\d{2})$/i;
    /* strip ? ! , and sentence-final dots, but KEEP dots inside a token (e.g. "my.app" must survive) */
    var toks = s.replace(/[?!,]/g, ' ').split(/\s+/), subj = [];
    for (var i = 0; i < toks.length; i++) {
      var t = (toks[i] || '').replace(/^\.+|\.+$/g, ''); if (!t) continue;
      var tl = t.toLowerCase();
      if (SCAFFOLD[tl] || PERIODW.test(tl)) continue;
      subj.push(t);
    }
    var subject = subj.join(' ');
    /* "how many chats in June" (no subject) is really a period question -> activity */
    if (intent === 'count' && period && !subject) intent = 'activity';
    return { kind: 'analytics', intent: intent, subject: subject, period: period, raw: s };
  }

  function docPasses(q, conv, doc) {
    if (q.source && (conv.source || 'claude') !== q.source) return false;
    if (q.sourceSet && !q.sourceSet[conv.source || 'claude']) return false;
    if (q.folder && (conv.project || '').toLowerCase().indexOf(q.folder) < 0) return false;
    if (q.from && doc.s !== q.from) return false;
    if (q.after && doc.d.slice(0, q.after.length) < q.after) return false;
    if (q.before && doc.d.slice(0, q.before.length) > q.before) return false;
    if (q.on && doc.d.slice(0, q.on.length) !== q.on) return false;
    if (q.chat && conv.name.toLowerCase().indexOf(q.chat) < 0) return false;
    if (q.hasAtt && !(conv.fileNames && conv.fileNames.length)) return false;
    if (q.file && !(conv.fileNames || []).some(function (n) { return n.toLowerCase().indexOf(q.file) >= 0; })) return false;
    var lower = null;
    for (var i = 0; i < q.phrases.length; i++) {
      if (lower === null) lower = doc.t.toLowerCase();
      var ph = q.phrases[i].toLowerCase();
      /* a phrase counts if it is in the message text OR the conversation title */
      if (lower.indexOf(ph) < 0 && conv.name.toLowerCase().indexOf(ph) < 0) return false;
    }
    for (var j = 0; j < q.excludes.length; j++) {
      if (lower === null) lower = doc.t.toLowerCase();
      var x = q.excludes[j];
      if (lower.indexOf(x) >= 0) return false;
      if (doc.fn && doc.fn.toLowerCase().indexOf(x) >= 0) return false;
      if (conv.name.toLowerCase().indexOf(x) >= 0) return false;
    }
    return true;
  }

  function convExcluded(q, conv) {
    if (!q.excludes.length) return false;
    for (var i = 0; i < q.excludes.length; i++) {
      var x = q.excludes[i];
      if (conv.name.toLowerCase().indexOf(x) >= 0) return true;
      if ((conv.fileNames || []).some(function (n) { return n.toLowerCase().indexOf(x) >= 0; })) return true;
      for (var j = 0; j < conv.docs.length; j++) {
        if (conv.docs[j].t.toLowerCase().indexOf(x) >= 0) return true;
      }
    }
    return false;
  }

  function convPasses(q, conv) {
    if (q.source && (conv.source || 'claude') !== q.source) return false;
    if (q.sourceSet && !q.sourceSet[conv.source || 'claude']) return false;
    if (q.folder && (conv.project || '').toLowerCase().indexOf(q.folder) < 0) return false;
    if (q.chat && conv.name.toLowerCase().indexOf(q.chat) < 0) return false;
    if (q.hasAtt && !(conv.fileNames && conv.fileNames.length)) return false;
    if (q.file && !(conv.fileNames || []).some(function (n) { return n.toLowerCase().indexOf(q.file) >= 0; })) return false;
    if (q.after && (conv.updated_at || '').slice(0, q.after.length) < q.after) return false;
    if (q.before && (conv.created_at || '').slice(0, q.before.length) > q.before) return false;
    if (q.on && ((conv.created_at || '').slice(0, q.on.length) > q.on || (conv.updated_at || '').slice(0, q.on.length) < q.on)) return false;
    if (convExcluded(q, conv)) return false;
    return true;
  }

  function describeFilters(q) {
    var parts = [];
    if (q.source) parts.push('source:' + q.source);
    else if (q.sourceSet) parts.push('source:' + Object.keys(q.sourceSet).join('+'));
    if (q.folder) parts.push('folder:' + q.folder);
    if (q.chat) parts.push('chat:' + q.chat);
    if (q.from) parts.push('from:' + (q.from === 'h' ? 'me' : 'claude'));
    if (q.after) parts.push('after:' + q.after);
    if (q.before) parts.push('before:' + q.before);
    if (q.on) parts.push('on:' + q.on);
    if (q.file) parts.push('file:' + q.file);
    else if (q.hasAtt) parts.push('has:attachment');
    q.excludes.forEach(function (x) { parts.push('-' + x); });
    q.phrases.forEach(function (p) { parts.push('"' + p + '"'); });
    return parts;
  }

  /* ---------- Search & render ---------- */
  function highlightTerms(q) {
    return q.terms.concat(q.phrases.reduce(function (acc, p) { return acc.concat(p.split(/\s+/)); }, [])).filter(Boolean);
  }

  /* mobile clear-button visibility: toggle a 'has' class on .searchwrap when the field has text.
     Called on input AND here in runSearch, so programmatic sets (folder chips, op hints, recent
     chips) light it up too. The button itself is desktop-hidden via CSS (native type=search × there). */
  function syncClear() {
    var s = document.getElementById('search'), w = s && s.parentNode;
    if (w && w.classList) w.classList.toggle('has', !!(s && s.value));
  }

  function runSearch() {
    var raw = state.query.trim();
    syncClear();
    if (raw && state.pinView) { state.pinView = false; markActiveTab(); } /* a real search leaves the pinned view */
    state.matchedTerms = []; /* repopulated below; reset so the reader never highlights stale terms */
    var resultsEl = $('#results');
    if (!state.convs.size) { resultsEl.innerHTML = ''; $('#count').textContent = ''; setDossier(null, ''); state.route = null; clearAnswer(); renderRecent(); $('#empty').style.display = 'block'; return; }
    $('#empty').style.display = 'none';

    if (!raw) { state.route = null; clearAnswer(); renderRecent(); renderBrowse(null); return; }
    if (!state.index) return;

    /* v1.30 query router: an analytics question ("how many invoices chats?", "câte ore la
       proiect?") answers itself. The SUBJECT (question minus scaffolding) drives the normal
       search below and the period becomes after:/before: operators, so the answer strip's
       numbers equal what renders. routeQuery returns kind:'search' for everything else and this
       is a no-op — search stays byte-for-byte pre-v1.30. */
    var route = routeQuery(raw);
    state.route = (route.kind === 'analytics' && !routeDismissed[raw.toLowerCase()]) ? route : null;
    var qraw = raw;
    if (state.route) {
      qraw = state.route.subject || '';
      if (state.route.period) qraw = (qraw ? qraw + ' ' : '') + 'after:' + state.route.period.after + ' before:' + state.route.period.before;
      qraw = qraw.trim();
      /* no subject to search ("how many chats last month", "how many chats do I have"): browse
         the (optionally period-filtered) archive; renderBrowse paints the strip over that list */
      if (!state.route.subject) { renderBrowse(state.route.period ? parseQueryGroups(qraw) : null); return; }
    }

    var groups = parseQueryGroups(qraw);
    /* sender filter UI (me/claude/both); an explicit from: operator in the query wins */
    if (state.sender) groups.forEach(function (g) { if (!g.from) g.from = state.sender; });
    /* source chips (multi-select since v1.26.0); an explicit source: operator wins */
    var tabSet = srcTabSet();
    if (tabSet) groups.forEach(function (g) { if (!g.source && !g.sourceSet) g.sourceSet = tabSet; });
    var searchableGroups = groups.filter(function (g) { return g.terms.length + g.phrases.length > 0; });

    /* filters-only query (no search words in any group): show matching conversations */
    if (!searchableGroups.length) { renderBrowse(groups); return; }

    var merged = new Map();
    var titleOnly = new Map(); /* conversations found only via their title */
    var matchedSet = {};       /* actual index words that matched (incl. fuzzy/prefix expansions) */
    var ignoredFilterGroup = groups.length > searchableGroups.length && groups.length > 1;
    groups.forEach(function (g) {
      var searchable = g.terms.concat(g.phrases).join(' ').trim();
      if (!searchable) return;
      var hits = state.index.search(searchable);
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        var conv = state.convs.get(h.convUuid);
        if (!conv) continue;
        var textual = false, t;
        for (t in h.match) {
          var fl = h.match[t];
          if (fl.indexOf('text') >= 0 || fl.indexOf('fn') >= 0) textual = true;
        }
        if (!textual) {
          /* every doc of a conv carries convName, so title matches arrive once per message —
             collapse them to ONE conversation-level entry instead of inflating the counts */
          if (g.from || titleOnly.has(h.convUuid)) continue;
          if (!convPasses(g, conv)) continue;
          var nameL = conv.name.toLowerCase(), ok = true;
          for (var p = 0; p < g.phrases.length; p++) {
            if (nameL.indexOf(g.phrases[p].toLowerCase()) < 0) { ok = false; break; }
          }
          if (!ok) continue;
          for (t in h.match) matchedSet[t] = 1;
          titleOnly.set(h.convUuid, { conv: conv, date: (conv.updated_at || '').slice(0, 10), score: h.score });
          continue;
        }
        var doc = conv.docs[parseInt(h.id.split(':')[1], 10)];
        if (!doc || !docPasses(g, conv, doc)) continue;
        for (t in h.match) matchedSet[t] = 1;
        var ms = Date.parse(h.date || '') || state.dateMin;
        h.rscore = h.score * (1 + 0.2 * ((ms - state.dateMin) / (state.dateMax - state.dateMin)));
        var ex = merged.get(h.id);
        if (!ex || h.rscore > ex.rscore) merged.set(h.id, h);
      }
    });
    var out = Array.from(merged.values());
    renderSearchResults(out, titleOnly, groups, qraw, matchedSet, ignoredFilterGroup, '', true);
    semAugment(out, titleOnly, groups, searchableGroups, qraw, matchedSet, ignoredFilterGroup);
  }

  /* the render tail of runSearch, factored out (v1.29) so the async hybrid pass can re-render the
     fused list without duplicating it. semNote rides the #count line ('' for pure keyword). */
  function renderSearchResults(out, titleOnly, groups, raw, matchedSet, ignoredFilterGroup, semNote, doAnswer) {
    var resultsEl = $('#results');
    var q = groups[0]; /* for zero-result wording */

    if (state.sort === 'newest') out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || b.rscore - a.rscore; });
    else out.sort(function (a, b) { return b.rscore - a.rscore; });

    var byConv = new Map(); /* do NOT name this `groups` — var-shadowing broke search (v1.7.1) */
    out.forEach(function (h) {
      var g = byConv.get(h.convUuid);
      if (!g) { g = { conv: state.convs.get(h.convUuid), hits: [] }; byConv.set(h.convUuid, g); }
      if (g.hits.length < 3) g.hits.push(h);
    });
    /* top-3 hits selected by score, displayed in conversation order */
    byConv.forEach(function (g) {
      g.hits.sort(function (a, b) { return parseInt(a.id.split(':')[1], 10) - parseInt(b.id.split(':')[1], 10); });
    });
    /* title-only conversations render first as compact rows — strongest signal, visually cheap */
    var extras = Array.from(titleOnly.values()).filter(function (e) { return !byConv.has(e.conv.uuid); });
    extras.sort(state.sort === 'newest'
      ? function (a, b) { return b.date.localeCompare(a.date) || b.score - a.score; }
      : function (a, b) { return b.score - a.score; });
    var ordered = extras.map(function (e) { return { conv: e.conv, hits: [] }; })
      .concat(Array.from(byConv.values()));

    $('#count').textContent = (out.length + extras.length) + ' matches in ' + ordered.length + ' conversations' +
      (extras.length ? ' (' + extras.length + ' by title)' : '') +
      (groups.length > 1 ? ' (' + groups.map(function (g) { return g.terms.concat(g.phrases).join(' ') || '[filters]'; }).join(' OR ') + ')' : '') +
      (ignoredFilterGroup ? ' — a filter-only OR side needs search words' : '') +
      (semNote || '');
    setDossier(ordered.map(function (g2) { return g2.conv; }), raw);
    /* v1.30 router: the answer strip is computed from the KEYWORD-matched conversations only
       (doAnswer true on the sync pass, false on the async hybrid re-render) so its counts mean
       "conversations that MENTION the subject", not fuzzy semantic neighbours. */
    if (doAnswer) { if (state.route) showAnswer(state.route, ordered.map(function (g2) { return g2.conv; })); else clearAnswer(); }
    var terms = groups.reduce(function (acc, g) { return acc.concat(highlightTerms(g)); }, []);
    for (var mt in matchedSet) { if (terms.indexOf(mt) < 0 && terms.length < 30) terms.push(mt); }
    state.matchedTerms = terms;
    var fdesc = describeFilters(q);
    resultsEl.innerHTML = ordered.slice(0, 60).map(function (g2) { return renderCard(g2, terms); }).join('') ||
      '<p class="nores">No matches for all of: ' + esc(q.terms.join(', ') || '(none)') +
      (fdesc.length ? ' with ' + esc(fdesc.join(' + ')) : '') +
      '. All words must match — try fewer words or remove a filter.</p>';
    saveRecentDebounced(raw);
  }

  /* ---------- Query-router answer strip (v1.30) ----------
     The answer is computed over the EXACT conversation set handed in (the keyword-matched
     convs from renderSearchResults, or the browsed list for period-only questions), reusing
     the Stats math so it can never disagree with the Stats page. Lives in its own #answer
     container above #results, so the async hybrid re-render leaves it untouched. */
  var routeDismissed = {}; /* per-session: a dismissed question shows no strip until retyped */

  function computeAnalytics(convList, intent, period) {
    var GAP = 30 * 60000, TAIL = 5; /* same session model as openStats */
    var inRange = function (day) { return !period ? true : (!!day && day >= period.after && day <= period.before); };
    var ev = [], msgs = 0, convHit = 0, minDay = '', maxDay = '', months = {};
    for (var ci = 0; ci < convList.length; ci++) {
      var c = convList[ci], hit = 0;
      for (var j = 0; j < c.docs.length; j++) {
        var d = c.docs[j];
        if (d.ty === 'a') continue; /* attachments aren't typing moments (Stats S1 rule) */
        var day = (d.d || '').slice(0, 10);
        if (!day || !inRange(day)) continue;
        hit++; msgs++;
        months[day.slice(0, 7)] = (months[day.slice(0, 7)] || 0) + 1;
        if (!minDay || day < minDay) minDay = day;
        if (!maxDay || day > maxDay) maxDay = day;
        if ((d.d || '').length > 10) { var ms = Date.parse(d.d); if (ms) ev.push(ms); }
      }
      if (hit) convHit++;
    }
    var ses = sessionize(ev, GAP, TAIL);
    return { convs: convHit, msgs: msgs, minDay: minDay, maxDay: maxDay, months: months, sessionMins: ses.mins, sessions: ses.n, timed: ev.length };
  }

  function answerStripHtml(route, a) {
    var subj = route.subject ? '“' + esc(route.subject) + '”' : 'your archive';
    var per = route.period ? esc(route.period.label) : '';
    var cN = a.convs.toLocaleString(), mN = a.msgs.toLocaleString();
    var convW = ' conversation' + (a.convs !== 1 ? 's' : ''), msgW = ' message' + (a.msgs !== 1 ? 's' : '');
    var main = '', sub = '';
    if (route.intent === 'time') {
      main = '~<b>' + fmtDur(a.sessionMins) + '</b>' + (a.sessions ? ' across ' + a.sessions.toLocaleString() + ' session' + (a.sessions !== 1 ? 's' : '') : '') +
        (route.subject ? ' on ' + subj : '') + (per ? ' · ' + per : '');
      sub = cN + convW + ' · ' + mN + msgW + (a.timed < a.msgs ? ' · ' + (a.msgs - a.timed).toLocaleString() + ' without a timestamp' : '');
    } else if (route.intent === 'firstlast') {
      main = a.minDay ? 'first <b>' + a.minDay + '</b> · last <b>' + a.maxDay + '</b>' + (route.subject ? ' — ' + subj : '')
                      : 'no dated messages' + (route.subject ? ' for ' + subj : '');
      var span = (a.minDay && a.maxDay) ? Math.round((Date.parse(a.maxDay) - Date.parse(a.minDay)) / 86400000) : 0;
      sub = cN + convW + ' · ' + mN + msgW + (span ? ' · ' + span.toLocaleString() + (span === 1 ? ' day apart' : ' days apart') : '');
    } else if (route.intent === 'activity') {
      main = (per || 'overall') + ': <b>' + cN + '</b>' + convW + ' · ' + mN + msgW;
      var mk = Object.keys(a.months).sort(), recent = mk.slice(-12), maxM = 1, peakK = '', peakV = 0;
      mk.forEach(function (k) { if (a.months[k] > peakV) { peakV = a.months[k]; peakK = k; } });
      recent.forEach(function (k) { if (a.months[k] > maxM) maxM = a.months[k]; });
      if (recent.length > 1) {
        sub = '<span class="ansbars">' + recent.map(function (k) {
          return '<i style="height:' + Math.max(8, Math.round(a.months[k] / maxM * 100)) + '%" title="' + k + ' · ' + a.months[k] + ' messages"></i>';
        }).join('') + '</span><span class="ansspan">' + recent[0] + ' → ' + recent[recent.length - 1] + (peakK ? ' · peak ' + peakK + ' (' + peakV.toLocaleString() + ')' : '') + '</span>';
      } else if (peakK) sub = 'peak ' + peakK + ' (' + peakV.toLocaleString() + msgW + ')';
    } else { /* count */
      main = '<b>' + cN + '</b>' + convW + (route.subject ? ' mention ' + subj : ' in total') + (per ? ' · ' + per : '');
      sub = mN + msgW + (a.minDay ? ' · ' + a.minDay + ' → ' + a.maxDay : '');
    }
    return '<div class="answer" role="note">' +
      '<div class="ans-head"><span class="ans-tag">quick answer</span>' +
      '<button type="button" class="ans-x" title="Not an analytics question? Hide this and search what you typed.">not this? ✕</button></div>' +
      '<div class="ans-main">' + main + '</div>' +
      (sub ? '<div class="ans-sub">' + sub + '</div>' : '') +
      '<div class="ans-foot">Computed locally, nothing uploaded · <button type="button" class="ans-stats">open full Stats ↗</button></div>' +
      '</div>';
  }

  function showAnswer(route, convList) {
    var el = $('#answer'); if (!el) return;
    el.innerHTML = answerStripHtml(route, computeAnalytics(convList, route.intent, route.period));
  }
  function clearAnswer() { var el = $('#answer'); if (el && el.innerHTML) el.innerHTML = ''; }

  /* hybrid RRF (task 6): when the ≈ toggle is ON and vectors are in memory, meaning-based matches
     join the keyword results and BOTH lists re-rank by Reciprocal Rank Fusion. Async on purpose
     (query embed ~110 ms): keyword results render instantly, the fused list replaces them when
     ready; a sequence guard drops stale responses. Toggle OFF ⇒ no-op — search is byte-for-byte
     pre-v1.29. Semantic candidates still pass docPasses, so operators/chips/sender apply. */
  var semSeq = 0, semReRunArmed = false, semDocsArmed = false, semDisabled = false;
  /* one place to give up on semantic: stop retrying (the per-search re-arm caused "keeps reloading" on
     the phone), flip the toggle off, and SHOW the real reason instead of swallowing it. A manual
     toggle-on clears it to retry. */
  function semFailed(err) {
    semDisabled = true;
    state.semOn = false;
    setMeta('semOn', false);
    var t = $('#sem-toggle'); if (t) t.setAttribute('aria-pressed', 'false');
    var msg = 'Semantic couldn’t load on this device: ' + ((err && err.message) || err || 'unknown error') + ' — keyword search still works.';
    /* v1.52.0 — GEMMA-ON-PHONE FALLBACK: if a bigger model failed to load on iOS, e5 vectors may
       still sit in the store (model-keyed, they coexist) — offer the one-tap way back instead of a
       dead end. No e5 vectors → name the e5 .cvec path. Desktop keeps the plain message. */
    if (isIOS() && SEM.KEY !== 'e5') {
      semVecCount(SEM_MODELS.e5.MODEL_KEY).then(function (n) {
        if (n) {
          toast(msg + ' Your e5 vectors are still on this phone — TAP THIS MESSAGE to switch semantic search back to e5.', true);
          state._toastAction = semBackToE5; /* armed AFTER the toast (stale-action rule) */
        } else {
          toast(msg + ' To use semantic on this phone, import an e5 .cvec (on your computer: switch to e5 → Download embeddings).', true);
        }
      });
      return;
    }
    toast(msg, true);
  }
  /* v1.52.0: the one-tap return to e5 (semFailed fallback · init eviction offer · manual escape) */
  function semBackToE5() {
    if (!semSetModel('e5')) return;
    setMeta('semModel', 'e5');
    semDisabled = false;
    state.semOn = true; setMeta('semOn', true);
    var t = $('#sem-toggle'); if (t) { t.hidden = false; t.setAttribute('aria-pressed', 'true'); }
    toast('Back on e5 — just search; its vectors load in seconds (model ~118 MB, once).');
    runSearch();
  }
  function semAugment(out, titleOnly, groups, searchableGroups, raw, matchedSet, ignoredFilterGroup) {
    var seq = ++semSeq;
    if (!state.semOn || semDisabled) return;
    var semQ = searchableGroups.map(function (g) { return g.terms.concat(g.phrases).join(' '); }).join(' ').trim();
    if (semQ.length < 3) return;
    /* v1.50.2 (live-caught: iOS crash-loop at BOOT): vectors are no longer preloaded at init on
       iOS — the ~50 MB load moved here, to the first ≈-active search, armed ONCE with visible
       progress (same pattern as the model arm below). A memory crash during a user action recovers
       on reload; a crash at boot puts Safari in its "problem repeatedly occurred" page and blocks
       the whole site. */
    if (!semRun.docs) {
      if (!semDocsArmed && !semRun.busy) {
        semDocsArmed = true;
        showProgress('Semantic: loading your vectors…', 30);
        /* v1.50.3 (live-caught: "stuck on loading your vectors"): a phone must never enter the
           embed pipeline here — since v1.52.0 that rule lives INSIDE semEnsureDocs (the one choke
           point: iOS → read-only semRebuildFromStore, desktop → embed top-up). setTimeout = paint
           the progress line before the synchronous doc pass (the v1.50.0 lesson). */
        setTimeout(function () {
          semEnsureDocs().then(
            function (ok) { hideProgress(); semDocsArmed = false; if (ok) runSearch(); },
            function () { hideProgress(); semDocsArmed = false; }
          );
        }, 50);
      }
      return;
    }
    /* FREEZE FIX (live-caught 2026-07-08): if the model is still initializing, do NOT stack query
       embeds behind it — typing interleaved ~1.9 s keyword searches with onnx init chunks until
       Chrome declared the page unresponsive. Arm ONE re-run for when the model is ready. (v1.50.2:
       progress now visible — this used to download ~112 MB into a no-op on the phone.) */
    if (!semExtractor) {
      if (!semReRunArmed) {
        semReRunArmed = true;
        semLoad(function (s) { showProgress('Semantic: ' + s, 60); }).then(
          function () { hideProgress(); semReRunArmed = false; runSearch(); },
          function (err) { hideProgress(); semReRunArmed = false; semFailed(err); }
        );
      }
      return;
    }
    semScan(semQ, 100).then(function (hits) {
      if (seq !== semSeq) return; /* a newer search took over (seq bumps once per runSearch; the
        old state.query equality check broke when the router searches the subject, not the question) */
      var pass = [];
      for (var i = 0; i < hits.length; i++) {
        var sh = hits[i], conv = state.convs.get(sh.convUuid);
        var doc = conv && conv.docs[sh.idx];
        if (!doc) continue;
        var okAny = false;
        for (var gi = 0; gi < searchableGroups.length; gi++) {
          if (docPasses(searchableGroups[gi], conv, doc)) { okAny = true; break; }
        }
        if (okAny) pass.push(sh);
      }
      if (!pass.length) return; /* keyword-only render stands */
      var kwRank = out.slice().sort(function (a, b) { return b.rscore - a.rscore; }).map(function (h) { return h.id; });
      var fused = semRRF([kwRank, pass.map(function (s) { return s.id; })]);
      var hmap = {}, added = 0;
      out.forEach(function (h) { hmap[h.id] = h; });
      pass.forEach(function (s) {
        if (!hmap[s.id]) { hmap[s.id] = { id: s.id, convUuid: s.convUuid, score: s.score, date: s.date, sem: true }; added++; }
      });
      var out2 = [];
      for (var id in fused) { if (hmap[id]) { hmap[id].rscore = fused[id]; out2.push(hmap[id]); } }
      /* audit cycle 3 (§11): count only matches NOT already in the keyword results — pass.length
         over-counted by up to ~21% measured; 0 new is still useful (semantic re-ranked the order) */
      renderSearchResults(out2, titleOnly, groups, raw, matchedSet, ignoredFilterGroup,
        added ? ' · ≈ hybrid: ' + added + ' semantic matches folded in'
              : ' · ≈ hybrid: re-ranked (all semantic matches already found by keyword)');
    }).catch(function () { /* semantic failure must never break keyword search */ });
  }

  /* non-claude sources get a badge and NO external link — Cowork/Code sessions have no web URL (honest limits) */
  function srcBadge(c) {
    var s = c.source || 'claude';
    return s === 'claude' ? '' : '<span class="srcb">' + s + '</span> · ';
  }
  function extLink(c) {
    if ((c.uuid || '').indexOf('demo-') === 0) return ''; /* sample rows link nowhere real */
    var s = c.source || 'claude';
    if (s === 'claude') return ' · <a class="rext" href="https://claude.ai/chat/' + esc(c.uuid) + '" target="_blank" rel="noopener" title="Open on claude.ai">↗</a>';
    /* claude://resume?session= imports CLI sessions from ~/.claude — works for source:code only;
       Cowork transcripts live in per-session config dirs the app can't see (tested 2026-07-02, §8) */
    if (s === 'code') return ' · <a class="rext" href="claude://resume?session=' + esc(c.uuid) + '" title="Open in the Claude desktop app (resumes this Claude Code session)">↗</a>';
    /* claude.ai Projects DO have stable URLs (unlike messages/files) — /project/<uuid> */
    if (s === 'project') return ' · <a class="rext" href="https://claude.ai/project/' + esc(c.uuid) + '" target="_blank" rel="noopener" title="Open this Project on claude.ai">↗</a>';
    /* ChatGPT conversations have stable URLs too — /c/<conversation_id> (own account, logged in) */
    if (s === 'chatgpt') return ' · <a class="rext" href="https://chatgpt.com/c/' + esc(c.uuid) + '" target="_blank" rel="noopener" title="Open on chatgpt.com">↗</a>';
    return '';
  }

  function folderChip(c) {
    if (!c.project) return '';
    return '<a class="pfold" href="#" data-folder="' + esc(c.project) + '" title="Show all sessions of this folder">\uD83D\uDCC1 ' + esc(c.project) + '</a> \u00b7 ';
  }

  function browseRow(c) {
    var uf = (c.fileNames || []).filter(function (n, ix, arr) { return arr.indexOf(n) === ix; }).length;
    var att = uf ? '<a class="filelink" href="#" data-conv="' + esc(c.uuid) + '" title="Show all files of this conversation">\uD83D\uDCCE ' + uf + '</a>' : '';
    return '<article class="card row">' + pinBtn(c) +
      '<span class="rdate">' + esc((c.updated_at || '').slice(0, 10)) + '</span>' +
      '<a class="rtitle readlink" href="#" data-conv="' + esc(c.uuid) + '" data-doc="0" title="Read here">' + esc(c.name) + '</a>' +
      '<span class="rmeta">' + folderChip(c) + srcBadge(c) + c.docs.length + ' msg' + (att ? ' \u00b7 ' + att : '') +
      extLink(c) + '</span>' +
      '</article>';
  }

  function renderBrowse(groups) {
    var list = Array.from(state.convs.values());
    /* empty-query browse: filter-only queries carry source via groups; plain browse honours the tab here */
    var tabSetB = srcTabSet();
    if (!groups && tabSetB) list = list.filter(function (c) { return tabSetB[c.source || 'claude']; });
    if (!groups && state.pinView) list = list.filter(function (c) { return isPinned(c.uuid); }); /* 📌 tab = pinned only */
    var fdesc = groups ? groups.map(function (g) { return describeFilters(g).join(' + ') || '(all)'; }).join(' OR ') : '';
    if (groups) list = list.filter(function (c) {
      return groups.some(function (g) { return convPasses(g, c); });
    });
    /* v1.30.1 alignment: for a subject-less analytics period question ("how active last month"),
       convPasses keeps convs whose created/updated OVERLAP the window even with no message in it —
       so the list (118) disagreed with the strip, which counts convs that actually have a message
       in range (114). Narrow the list to the same message-level test so count line, dossier, cards
       and strip all agree. Only in the router's period path; manual after:/before: browse is
       untouched (there, conv-overlap is the right, long-standing meaning). */
    if (state.route && state.route.period) {
      var per = state.route.period;
      list = list.filter(function (c) {
        for (var j = 0; j < c.docs.length; j++) {
          var d = c.docs[j]; if (d.ty === 'a') continue;
          var day = (d.d || '').slice(0, 10);
          if (day && day >= per.after && day <= per.before) return true;
        }
        return false;
      });
    }
    list.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
    $('#count').textContent = list.length + ' conversations' + (fdesc ? ' matching ' + fdesc : ' \u2014 newest first') +
      (groups && !list.length ? ' \u2014 remove one filter at a time to see which is too narrow' : '');
    if (state.pinView) $('#count').textContent = list.length + ' pinned conversation' + (list.length === 1 ? '' : 's');
    /* dossier covers the visible set, but only for an ACTIVE query/filter (search terms, folder:,
       source: operator). A bare source TAB (or plain browse-all) does NOT show it \u2014 a full-category
       export should be a deliberate query, not a side effect of which tab you're viewing. Clearing
       the search hides the button on any tab. `source:cowork` typed explicitly still yields one. */
    setDossier(groups ? list : null, fdesc);
    /* v1.30 router: a subject-less analytics question ("how many chats last month") lands here \u2014
       paint the answer strip over the browsed list; any other browse clears a stale strip. */
    if (state.route) showAnswer(state.route, list); else clearAnswer();
    /* Pinned section at the top of plain "all" browse (no search, no source tab, not the \ud83d\udccc view).
       Pinned convs render first under a \ud83d\udccc header, then removed from the list below so they don't repeat. */
    var pinnedHtml = '';
    if (!groups && !state.pinView && !state.srcTabs.length && !state.route && state.pins.length) {
      var pinnedList = state.pins.map(function (u) { return state.convs.get(u); }).filter(Boolean);
      if (pinnedList.length) {
        pinnedHtml = pinnedList.map(browseRow).join(''); /* pinned chats float to the top, marked by their red \ud83d\udccc \u2014 no section header (Eugen 2026-07-09) */
        list = list.filter(function (c) { return !isPinned(c.uuid); });
      }
    }

    /* Cowork/Code tabs group plain browse by working folder \u2014 sessions ARE the project structure */
    if (!groups && state.srcTabs.length && state.srcTabs.every(function (t) { return t === 'cowork' || t === 'code'; })) {
      var byFolder = new Map();
      list.forEach(function (c) {
        var k = c.project || '(no folder)';
        var g = byFolder.get(k);
        if (!g) { g = { name: k, items: [] }; byFolder.set(k, g); }
        g.items.push(c); /* list already newest-first, groups inherit that order */
      });
      var folders = Array.from(byFolder.values());
      folders.sort(function (a, b) { return (b.items[0].updated_at || '').localeCompare(a.items[0].updated_at || ''); });
      $('#results').innerHTML = folders.map(function (g) {
        return '<div class="fghead">\uD83D\uDCC1 ' + esc(g.name) + ' <span>' + g.items.length + ' session' + (g.items.length > 1 ? 's' : '') + '</span></div>' +
          g.items.map(browseRow).join('');
      }).join('');
      return;
    }
    $('#results').innerHTML = pinnedHtml + list.map(browseRow).join('');
  }

  /* ---------- Dossier export: current result set -> ONE chronological .md (v1.18.0) ----------
     The consumer is a human OR a fresh AI chat (attach the file as context). Full conversations,
     oldest first; text attachments inlined and marked — pasted lab results / logs ARE the data.
     No redaction: the file goes to the user's own disk (redaction stays a me.skill concern). */
  function setDossier(convs, label) {
    state.dossier = (convs && convs.length) ? { convs: convs, label: label || 'archive' } : null;
    var n = state.dossier ? convs.length : 0;
    var b = $('#dossier-btn'), s = $('#summary-btn');
    if (b) { b.hidden = !state.dossier; if (state.dossier) b.textContent = '⬇ dossier (' + n + ')'; }
    if (s) { s.hidden = !state.dossier; if (state.dossier) s.textContent = 'summary (' + n + ')'; }
  }

  function buildDossier(convs, label) {
    var sorted = convs.slice().sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
    var msgs = 0, lo = '', hi = '';
    sorted.forEach(function (c) {
      msgs += c.docs.length;
      var d = (c.created_at || '').slice(0, 10);
      var u = (c.updated_at || c.created_at || '').slice(0, 10);
      if (d && (!lo || d < lo)) lo = d;
      if (u && u > hi) hi = u;
    });
    var out = ['# colloquary dossier — ' + label, '',
      sorted.length + ' conversation' + (sorted.length > 1 ? 's' : '') + ' · ' + msgs + ' messages' + (lo ? ' · ' + lo + ' → ' + hi : ''),
      'Generated locally by colloquary. Chronological, oldest first; 📎 marks inlined text attachments.', ''];
    sorted.forEach(function (c) {
      out.push('---', '');
      out.push('## ' + (c.created_at || '').slice(0, 10) + ' — ' + c.name +
        '  (' + (c.source || 'claude') + (c.project ? ' · 📁 ' + c.project : '') + ' · ' + c.docs.length + ' msg)', '');
      c.docs.forEach(function (doc) {
        var when = dNice(doc.d);
        if (doc.ty === 'a') out.push('**📎 ' + (doc.fn || 'attachment') + '** (' + when + '):', '', doc.t, '');
        else out.push('**' + (doc.s === 'h' ? 'You' : 'Claude') + '** (' + when + '):', '', doc.t, '');
      });
    });
    return out.join('\n');
  }

  /* ---- extractive summary (compiler recipe #1: scope -> select -> detect -> template) ----
     Honest by construction: every line is pulled VERBATIM from the archive; nothing is generated.
     Two producers share the spine: buildConvSummary (one conversation) + buildSetSummary (a scope).
     The Compile surface later swaps the template for a .skill and adds the semantic lens. */
  function sumClean(s, n) { /* collapse to one line, cap at n chars on a word boundary */
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  }
  function sumLead(s, n) { /* first sentence, else first n chars */
    s = (s || '').replace(/\s+/g, ' ').trim();
    var m = s.slice(0, n + 80).match(/^.*?[.!?](\s|$)/);
    return sumClean(m ? m[0] : s, n);
  }
  /* short human reply that reads as a decision/approval (a light version of the me.skill acceptance cue) */
  var SUM_DECISION = /^(ok(ay)?|yes|yep|yeah|sure|no|nope|go\b|do it|perfect|great|nice|ship|approved?|agreed?|let'?s\b|use\b|pick\b|option\b|sounds good|looks good|works|correct|exactly|right|confirmed?)\b/i;
  function convDialogue(c) { /* dialogue messages only (text attachments excluded) */
    return (c.docs || []).filter(function (d) { return d.ty !== 'a'; });
  }

  function buildConvSummary(c) {
    var dlg = convDialogue(c);
    var humans = dlg.filter(function (d) { return d.s === 'h'; });
    var asst = dlg.filter(function (d) { return d.s === 'a'; });
    var files = (c.fileNames || []).filter(function (n, i, a) { return a.indexOf(n) === i; });
    var lo = dDay(c.created_at), hi = dDay(c.updated_at || c.created_at), src = c.source || 'claude';
    var out = ['# Summary — ' + c.name, '',
      '_Extract — pulled verbatim from your messages, nothing generated._', '',
      src + (c.project ? ' · 📁 ' + c.project : '') + ' · ' + (lo === hi ? lo : lo + ' → ' + hi) +
        ' · ' + dlg.length + ' message' + (dlg.length === 1 ? '' : 's') +
        (files.length ? ' · ' + files.length + ' file' + (files.length === 1 ? '' : 's') : ''), ''];

    if (humans.length) out.push('**The ask**', '', sumClean(msRedact(humans[0].t), 400), '');

    /* key points = the most substantive assistant messages, shown in chronological order */
    var top = asst.map(function (d, i) { return { i: i, d: d }; })
      .sort(function (a, b) { return b.d.t.length - a.d.t.length; }).slice(0, 5)
      .sort(function (a, b) { return a.i - b.i; });
    if (top.length) {
      out.push('**Key points**', '');
      top.forEach(function (o) { out.push('- ' + sumLead(msRedact(o.d.t), 200)); });
      out.push('');
    }

    /* decisions = short human replies right after an assistant message, carrying a decision cue */
    var decisions = [];
    for (var i = 1; i < dlg.length && decisions.length < 6; i++) {
      if (dlg[i].s !== 'h' || dlg[i - 1].s !== 'a') continue;
      var t = dlg[i].t.replace(/\s+/g, ' ').trim();
      if (t.split(' ').length <= 15 && SUM_DECISION.test(t)) decisions.push(t);
    }
    if (decisions.length) {
      out.push('**Decisions you made**', '');
      decisions.forEach(function (t) { out.push('- "' + sumClean(msRedact(t), 160) + '"'); });
      out.push('');
    }

    /* possibly open = your last message was an unanswered question */
    var last = dlg[dlg.length - 1];
    if (last && last.s === 'h' && /\?\s*$/.test(last.t.trim())) {
      out.push('**Possibly open** (your last message was a question)', '', sumClean(msRedact(last.t), 240), '');
    }

    if (files.length) out.push('**Files:** ' + files.slice(0, 12).join(' · ') +
      (files.length > 12 ? ' · +' + (files.length - 12) : ''), '');
    return out.join('\n');
  }

  function buildSetSummary(convs, label) {
    var GAP = 30 * 60000, TAIL = 5; /* same session model as Stats */
    var sorted = convs.slice().sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
    var lo = '', hi = '', ev = [], bySrc = {};
    sorted.forEach(function (c) {
      var d = dDay(c.created_at), u = dDay(c.updated_at || c.created_at);
      if (d && (!lo || d < lo)) lo = d;
      if (u && u > hi) hi = u;
      var s = c.source || 'claude'; bySrc[s] = (bySrc[s] || 0) + 1;
      (c.docs || []).forEach(function (doc) {
        if (doc.ty === 'a') return;
        var ms = Date.parse((doc.d || '').replace(' ', 'T'));
        if (ms) ev.push(ms);
      });
    });
    var ses = sessionize(ev, GAP, TAIL), hrs = ses.mins / 60;
    var srcLine = Object.keys(bySrc).sort(function (a, b) { return bySrc[b] - bySrc[a]; })
      .map(function (s) { return s + ' ' + bySrc[s]; }).join(' · ');
    var out = ['# Summary — ' + label, '',
      '_Extract — your own words, nothing generated._', '',
      sorted.length + ' conversation' + (sorted.length === 1 ? '' : 's') +
        (lo ? ' · ' + (lo === hi ? lo : lo + ' → ' + hi) : '') +
        (ev.length ? ' · ~' + (hrs >= 10 ? Math.round(hrs) : hrs.toFixed(1)) + ' h across ' +
          ses.n + ' session' + (ses.n === 1 ? '' : 's') : ''), '',
      'Sources: ' + srcLine, '',
      '## Conversations (oldest first)', ''];
    var CAP = 300;
    sorted.slice(0, CAP).forEach(function (c) {
      var h = convDialogue(c).filter(function (d) { return d.s === 'h'; })[0];
      out.push('- ' + dDay(c.created_at) + ' · ' + c.name + ' (' + (c.source || 'claude') + ')' +
        (h ? ' — ' + sumClean(msRedact(h.t), 120) : ''));
    });
    if (sorted.length > CAP) out.push('', '_+' + (sorted.length - CAP) + ' more (narrow the search to summarize them)._');
    return out.join('\n');
  }

  /* custom lens (the compiler's open-ended mode): a free-text phrase → semScan selects on-topic
     passages by MEANING → this extractive brief of what the archive says about that topic. Passages are
     pre-resolved by the caller (semScan hit → real doc) so this function stays pure/testable. */
  function buildLensSummary(phrase, passages, coverage, calib) {
    var byConv = {}, order = [], lo = '', hi = '';
    passages.forEach(function (p) {
      var d = dDay(p.date);
      if (d && (!lo || d < lo)) lo = d;
      if (d && d > hi) hi = d;
      if (!byConv[p.conv]) { byConv[p.conv] = { n: 0, source: p.source || 'claude', best: -Infinity, date: d }; order.push(p.conv); }
      var g = byConv[p.conv]; g.n++; if (p.score > g.best) g.best = p.score; if (d && (!g.date || d > g.date)) g.date = d;
    });
    var out = ['# Compiled — "' + phrase + '"', '',
      '_Semantic lens — the on-topic passages the meaning-search surfaced, pulled verbatim. Nothing generated._', ''];
    if (coverage) out.push('_' + coverage + '_', '');
    if (calib) out.push('_' + calib + '_', '');
    out.push(
      passages.length + ' passage' + (passages.length === 1 ? '' : 's') + ' across ' +
        order.length + ' conversation' + (order.length === 1 ? '' : 's') +
        (lo ? ' · ' + (lo === hi ? lo : lo + ' → ' + hi) : ''), '',
      '## On-topic passages (most relevant first)', '');
    passages.slice(0, 20).forEach(function (p) {
      var who = p.ty === 'a' ? '📎 ' + (p.fn || 'file') : (p.s === 'h' ? 'you' : 'assistant');
      var sc = (p.score != null) ? '`' + p.score.toFixed(2) + '` · ' : '';
      out.push('- ' + sc + '**' + who + '** · ' + dDay(p.date) + ' · ' + p.conv + ' — ' + sumLead(msRedact(p.text), 220));
    });
    out.push('', '## Conversations', '');
    order.sort(function (a, b) { return byConv[b].best - byConv[a].best; }).slice(0, 25).forEach(function (name) {
      var g = byConv[name];
      out.push('- ' + (g.date || '') + ' · ' + name + ' (' + g.source + ') — ' + g.n + ' passage' + (g.n === 1 ? '' : 's'));
    });
    return out.join('\n');
  }

  /* generate -> preview in the reader for review (the me.skill pattern); Save PDF keeps it */
  function previewSummary(title, md) {
    var today = new Date().toISOString().slice(0, 10);
    openReader({ uuid: '', name: title, created_at: today, updated_at: today, msgCount: 1,
      schema: SCHEMA, fileNames: [], docs: [{ s: 'a', d: today, t: md }] }, 0);
  }

  function renderCard(g, terms) {
    var c = g.conv;
    if (!c) return '';
    var snippets = g.hits.map(function (h) {
      var idx = parseInt(h.id.split(':')[1], 10);
      var doc = c.docs[idx];
      if (!doc) return '';
      var who = (h.sem ? '≈ ' : '') + (doc.s === 'h' ? 'you' : 'claude'); /* ≈ = found by meaning, not keywords */
      var att = doc.ty === 'a' ? '<span class="attn">\uD83D\uDCCE ' + esc(doc.fn) + '</span> ' : '';
      return '<a class="snippet" href="#" data-conv="' + esc(c.uuid) + '" data-doc="' + idx + '" title="Read this conversation here, at this message">' +
        '<span class="who">' + who + '</span> ' + att + snippet(doc.t, terms) + '</a>';
    }).join('');
    var uf = (c.fileNames || []).filter(function (n, ix, arr) { return arr.indexOf(n) === ix; }).length;
    var att2 = uf ? ' · <a class="filelink" href="#" data-conv="' + esc(c.uuid) + '" title="Show all files of this conversation">📎 ' + uf + '</a>' : '';
    var first = g.hits[0]; /* absent when the conversation matched only by title */
    var date = first ? dDay(first.date) : (c.updated_at || '').slice(0, 10);
    var firstIdx = first ? parseInt(first.id.split(':')[1], 10) || 0 : 0;
    return '<article class="card res"><div class="rhead">' + pinBtn(c) +
      '<span class="rdate">' + esc(date) + '</span>' +
      '<a class="rtitle readlink" href="#" data-conv="' + esc(c.uuid) + '" data-doc="' + firstIdx + '" title="' + (first ? 'Read here, at the first match' : 'Conversation title matches — read here') + '">' + esc(c.name) + '</a>' +
      '<span class="rmeta">' + srcBadge(c) + c.docs.length + ' msg' + att2 +
      extLink(c) + '</span>' +
      '</div>' + snippets + '</article>';
  }

  function snippet(text, terms) {
    var lower = fold(text.toLowerCase());
    var pos = -1;
    for (var i = 0; i < terms.length; i++) {
      var p = lower.indexOf(fold(terms[i].toLowerCase()));
      if (p >= 0 && (pos < 0 || p < pos)) pos = p;
    }
    if (pos < 0) pos = 0;
    var start = Math.max(0, pos - 70);
    var end = Math.min(text.length, pos + 160);
    var s = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\n+/g, ' ') + (end < text.length ? '…' : '');
    return highlight(esc(s), terms);
  }

  var VARIANTS = { a: 'aàáâãäåăą', c: 'cçćč', d: 'dđ', e: 'eèéêëė', g: 'gğ', i: 'iìíîï', l: 'lł', n: 'nñń', o: 'oòóôõöő', r: 'rř', s: 'sșşš', t: 'tțţť', u: 'uùúûüű', y: 'yýÿ', z: 'zžźż' };

  /* one term -> regex source. Diacritic-tolerant per letter; non-letters match their ESCAPED
     form (index tokens can contain <>&` — MiniSearch splits on punctuation, not symbols, and a
     raw "term<" would chew into our own </mark> tags: the v1.7.5 lesson). */
  function termRegex(t) {
    var folded = fold(t.toLowerCase()), out = '';
    for (var i = 0; i < folded.length; i++) {
      var ch = folded[i];
      if (VARIANTS[ch]) out += '[' + VARIANTS[ch] + ']';
      else out += esc(ch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return out;
  }

  function highlight(safeText, terms) {
    var out = safeText;
    terms.forEach(function (t) {
      if (t.length < 2) return;
      /* (?![^<>]*>) keeps matches out of tag internals (e.g. searching the word "mark") */
      var re = new RegExp('(' + termRegex(t) + ')(?![^<>]*>)', 'gi');
      out = out.replace(re, '<mark>$1</mark>');
    });
    return out;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function deepLink(uuid, text, terms) {
    var base = 'https://claude.ai/chat/' + encodeURIComponent(uuid);
    if (!text) return { url: base, phrase: '' };
    var lower = fold(text.toLowerCase());
    var pos = -1;
    for (var i = 0; i < terms.length; i++) {
      var p = lower.indexOf(fold(terms[i].toLowerCase()));
      if (p >= 0 && (pos < 0 || p < pos)) pos = p;
    }
    if (pos < 0) return { url: base, phrase: '' };
    var start = pos;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    var slice = text.slice(start, start + 120).split(/\n/)[0];
    var words = slice.split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return { url: base, phrase: '' };
    var phrase = words.join(' ');
    var frag = encodeURIComponent(phrase).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
    return { url: base + '#:~:text=' + frag, phrase: phrase };
  }

  /* ---------- Recent searches ---------- */
  var recentTimer = null;
  function saveRecentDebounced(raw) {
    clearTimeout(recentTimer);
    recentTimer = setTimeout(function () {
      if (raw.length < 3) return;
      state.recent = [raw].concat(state.recent.filter(function (r) { return r !== raw; })).slice(0, 10);
      setMeta('recentSearches', state.recent);
      renderRecent();
    }, 2500);
  }

  function renderRecent() {
    var btn = $('#recent-btn'), pop = $('#recent-pop');
    var pinned = state.pinnedSearches || [];
    var recents = (state.recent || []).filter(function (r) { return pinned.indexOf(r) < 0; }); /* pinned float out of recents */
    /* the button (and its separator) only makes sense when there is something to show — otherwise the
       separator wraps onto its own line after the operators and reads as a big empty gap (mobile). */
    var show = (pinned.length || recents.length) ? '' : 'none';
    btn.style.display = show;
    var sep = document.querySelector('.hints .tr-sep');
    if (sep) sep.style.display = show;
    var row = function (q, on) {
      return '<div class="rc-row">' +
        '<button class="chip rc-run" data-q="' + esc(q) + '" title="Run this search">' + esc(q) + '</button>' +
        '<button class="rc-pin' + (on ? ' on' : '') + '" data-pinq="' + esc(q) + '" title="' + (on ? 'Unpin search' : 'Pin search') + '" aria-label="' + (on ? 'Unpin search' : 'Pin search') + '">📌</button>' +
        '</div>';
    };
    var html = '';
    if (pinned.length) html += '<div class="rc-sec">📌 pinned</div>' + pinned.map(function (q) { return row(q, true); }).join('');
    if (recents.length) html += (pinned.length ? '<div class="rc-sec">recent</div>' : '') + recents.map(function (q) { return row(q, false); }).join('');
    if (recents.length) html += '<button class="chip rc-clear" id="recent-clear">✕ clear history</button>';
    pop.innerHTML = html;
  }

  /* ---------- Import flow ---------- */
  /* ---------- "Try a sample archive" (C5, v1.27.0) ----------
     A stranger must see the app WORKING before trusting it with a real export. Clearly fake
     data (every title says "Sample:", uuids demo-*), loads only into an EMPTY archive, one-click
     clear; any real import clears it automatically first. No network — generated right here. */
  function demoConvs() {
    var mk = function (uuid, name, extra) {
      return Object.assign({ uuid: 'demo-' + uuid, name: 'Sample: ' + name, schema: SCHEMA,
        fileNames: [], docs: [] }, extra);
    };
    var d1 = mk('0001', 'packing for a rainy hiking trip', {
      created_at: '2026-05-02T08:10:00Z', updated_at: '2026-05-02T08:40:00Z', msgCount: 4,
      fileNames: ['packing-list.md', 'trail-photo.jpg'],
      docs: [
        { s: 'h', d: '2026-05-02T09:10', t: 'Packing for a 3-day hike, rain expected the whole weekend. What am I forgetting? List attached.' },
        { s: 'h', d: '2026-05-02T09:10', t: '# Packing list\n- tent + rain fly\n- sleeping bag\n- stove, lighter\n- first aid kit\n- headlamp', ty: 'a', fn: 'packing-list.md' },
        { s: 'a', d: '2026-05-02T09:11', t: 'Good base. Missing for rain: pack liner or dry bags, spare socks (two pairs), gaiters, and a trash bag for wet gear. Check the tent seams before you leave.' },
        { s: 'h', d: '2026-05-02T09:14', t: 'perfect, thanks' }
      ] });
    var d2 = mk('0002', 'fixing a Python date bug', {
      created_at: '2026-06-11T18:00:00Z', updated_at: '2026-06-11T18:30:00Z', msgCount: 4,
      docs: [
        { s: 'h', d: '2026-06-11T19:00', t: 'My script shows yesterday for events created after midnight. Timezone bug?' },
        { s: 'a', d: '2026-06-11T19:01', t: 'Classic UTC-vs-local issue: you parse the ISO timestamp as UTC but format it with the server locale. Convert to the user timezone before taking .date().' },
        { s: 'h', d: '2026-06-11T19:08', t: 'no, still the same after that change' },
        { s: 'a', d: '2026-06-11T19:09', t: 'Then the stored value is already local — drop the UTC assumption: parse it naive and only attach a timezone at display time. That matches the symptom exactly.' }
      ] });
    var d3 = mk('0003', 'sourdough starter rescue', {
      created_at: '2026-03-15T07:00:00Z', updated_at: '2026-03-15T07:20:00Z', msgCount: 2,
      docs: [
        { s: 'h', d: '2026-03-15T08:00', t: 'My sourdough starter smells like acetone and has grey liquid on top. Dead?' },
        { s: 'a', d: '2026-03-15T08:01', t: 'Not dead — hungry. The liquid is hooch. Pour it off, discard half, feed 1:1:1 twice a day somewhere warm, and it should bounce back within three days.' }
      ] });
    var d4 = mk('0004', 'planning a Lisbon weekend', {
      created_at: '2023-09-20T10:00:00Z', updated_at: '2023-09-20T10:30:00Z', msgCount: 4, source: 'chatgpt',
      docs: [
        { s: 'h', d: '2023-09-20T13:00', t: 'Two days in Lisbon in October — what should we not miss? We like food markets and viewpoints, not museums.' },
        { s: 'a', d: '2023-09-20T13:01', t: 'Day 1: Alfama and the miradouros, Time Out Market for lunch, tram 28 late afternoon. Day 2: LX Factory brunch, Belém pastries, sunset at Miradouro da Graça.' },
        { s: 'h', d: '2023-09-20T13:05', t: 'is the tram very crowded?' },
        { s: 'a', d: '2023-09-20T13:06', t: 'Very, at midday. Ride it before 9am or after 7pm — same views, half the crowd.' }
      ] });
    var d5 = mk('0005', 'kitchen tiles layout', {
      created_at: '2026-01-08T16:00:00Z', updated_at: '2026-01-08T16:45:00Z', msgCount: 4, source: 'chatgpt',
      docs: [
        { s: 'h', d: '2026-01-08T18:00', t: 'Kitchen wall 2.6 m wide, tiles 30x60 — center the layout or start from the corner?' },
        { s: 'a', d: '2026-01-08T18:01', t: 'Center it: with 2.6 m you get 4 full tiles plus 10 cm cuts at BOTH ends, which looks intentional. Corner-start leaves one ugly 20 cm sliver.' },
        { s: 'h', d: '2026-01-08T18:10', t: 'and around the window?' },
        { s: 'a', d: '2026-01-08T18:11', t: 'Align a grout line with the window edge if it lands within 3 cm of one — shift the whole field, not just that row.' }
      ] });
    var d6 = mk('0006', 'demo-website: contact form wiring', {
      created_at: '2026-06-28T09:00:00Z', updated_at: '2026-06-28T10:00:00Z', msgCount: 3,
      source: 'cowork', project: 'demo-website', fileNames: ['index.html'],
      docs: [
        { s: 'h', d: '2026-06-28T12:00', t: 'wire the contact form to send via the serverless endpoint, keep the honeypot field' },
        { s: 'a', d: '2026-06-28T12:02', t: 'Done — the form posts JSON to /api/contact, honeypot rejects bots server-side, and there is an inline success state instead of a redirect.' },
        { s: 'a', d: '2026-06-28T12:02', t: '<!doctype html>\n<form id="contact">\n  <input name="email" type="email" required>\n  <input name="website" class="hp" tabindex="-1">\n  <textarea name="message"></textarea>\n</form>', ty: 'a', fn: 'index.html' }
      ] });
    var d7 = mk('0007', 'demo-scripts: backup cron', {
      created_at: '2026-07-01T21:00:00Z', updated_at: '2026-07-01T21:20:00Z', msgCount: 2,
      source: 'code', project: 'demo-scripts',
      docs: [
        { s: 'h', d: '2026-07-01T22:00', t: 'add a nightly cron that tars the data folder and keeps the last 7 archives' },
        { s: 'a', d: '2026-07-01T22:03', t: 'Added: 02:30 nightly, tar.gz with the date in the name, and a find -mtime +7 -delete cleanup so exactly a week of backups is kept.' }
      ] });
    var d8 = mk('0008', 'Sample Project knowledge', {
      created_at: '2026-04-01T09:00:00Z', updated_at: '2026-04-10T09:00:00Z', msgCount: 2,
      source: 'project', project: 'Sample Project', name: 'Sample Project',
      fileNames: ['style-guide.md', 'glossary.md'],
      docs: [
        { s: 'h', d: '2026-04-01T12:00', t: '# Style guide\nShort sentences. Active voice. Numbers as digits. Never say leverage.', ty: 'a', fn: 'style-guide.md' },
        { s: 'h', d: '2026-04-10T12:00', t: '# Glossary\nHQ = the main office. GF = ground floor. The Wall = the load-bearing brick wall in reception.', ty: 'a', fn: 'glossary.md' }
      ] });
    return [d1, d2, d3, d4, d5, d6, d7, d8];
  }

  /* the banner and the import auto-clear derive from STATE (are demo-* records present?),
     never from a stored flag — a flag can desync from reality (seen live: banner on an empty
     archive after a clear); the archive itself cannot. */
  function hasDemo() {
    var found = false;
    state.convs.forEach(function (c, k) { if (k.indexOf('demo-') === 0) found = true; });
    return found;
  }

  function removeDemo() {
    return new Promise(function (res) {
      var tx = db.transaction('conversations', 'readwrite');
      var store = tx.objectStore('conversations');
      state.convs.forEach(function (c, k) { if (k.indexOf('demo-') === 0) store.delete(k); });
      tx.oncomplete = function () {
        Array.from(state.convs.keys()).forEach(function (k) { if (k.indexOf('demo-') === 0) state.convs.delete(k); });
        res();
      };
      tx.onerror = function () { res(); };
    });
  }

  function installDemo() {
    if (state.convs.size) { toast('The sample loads only into an empty archive — you already have real data.', true); return; }
    upsertConvs(demoConvs()).then(function () {
      return rebuildIndex();
    }).then(function () {
      renderStats(); runSearch();
      toast('Sample archive loaded — 8 clearly fake conversations across all sources. Explore search, Stats, the Token coach… then Clear sample.');
    });
  }

  function clearDemo() {
    removeDemo().then(function () { return rebuildIndex(); }).then(function () {
      renderStats(); runSearch();
      toast('Sample cleared. Drop your real export whenever you are ready — it never leaves this browser.');
    });
  }

  function runImportWorker(payload, label) {
    /* a real import replaces the sample (C5): clear demo-* records first, silently */
    if (hasDemo()) removeDemo();
    var workerSrc = document.getElementById('worker-src').textContent;
    var blob = new Blob([workerSrc], { type: 'application/javascript' });
    var w = new Worker(URL.createObjectURL(blob));
    w.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'progress') showProgress(m.stage, m.pct);
      else if (m.type === 'error') { hideProgress(); toast(m.message, true); w.terminate(); }
      else if (m.type === 'done') {
        w.terminate();
        showProgress('Merging into your archive…', 96);
        upsertConvs(m.convs).then(function (r) {
          setMeta('lastImport', { at: new Date().toISOString(), file: label, added: r.added, updated: r.updated });
          showProgress('Rebuilding search index…', 98);
          setTimeout(function () {
            rebuildIndex();
            hideProgress();
            renderStats();
            runSearch();
            if (!r.added && !r.updated) {
              if (m.native) {
                /* a re-dropped colloquary archive that this browser already holds in full */
                toast('This archive backup is already fully imported in this browser — nothing new to add (' + r.unchanged + ' conversations).');
              } else {
                /* everything byte-matched the archive — most often a re-dropped older export */
                var newest = '';
                m.convs.forEach(function (c) { if ((c.updated_at || '') > newest) newest = c.updated_at || ''; });
                toast('Nothing new or changed — every conversation in this file matched the archive. Newest activity in the file: ' +
                  (newest.slice(0, 10) || 'unknown') + '. If you expected updates, check you downloaded the LATEST export (generation lags the request; the email links the fresh one).');
              }
            } else {
              toast('Imported: ' + r.added + ' new, ' + r.updated + ' updated, ' + r.unchanged + ' unchanged.' +
                (m.files ? ' ' + m.files + ' text file' + (m.files > 1 ? 's' : '') + ' from session folders attached.' : '') +
                (m.skipped ? ' (' + m.skipped + ' subagent/empty sessions skipped.)' : ''));
              semAfterImport(); /* v1.29: user opted into semantic ⇒ embed only the new docs */
            }
          }, 30);
        });
      }
    };
    w.onerror = function (err) { hideProgress(); toast('Worker error: ' + err.message, true); };
    w.postMessage(payload);
  }

  function importFile(file) {
    showProgress('Reading ' + file.name + '…', 2);
    runImportWorker({ file: file }, file.name);
  }

  /* ---------- Claude Code / Cowork session import (folder picker or folder drop) ---------- */
  var SESSION_PATH_RE = /(^|\/)local_[0-9a-f-]+\.json$|(^|\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
  /* v1.21.0: a session's outputs/ + uploads/ hold REAL file text the transcript never carries —
     collect the text candidates too (path/ext/size checks only; the worker re-checks + attaches).
     MUST mirror worker.js PAYLOAD_* — change both together. */
  var PAYLOAD_PATH_RE = /(^|\/)local_[0-9a-f-]+\/(outputs|uploads)\//i;
  var PAYLOAD_EXT_RE = /\.(md|txt|py|js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|html|htm|css|csv|sh|log|toml|ini|sql)$/i;
  var PAYLOAD_SKIP_RE = /(^|\/)(unpacked[^\/]*|word|xl|ppt|_rels|docProps|customXml|media|node_modules|\.git|dist|build|\.next|coverage)(\/|$)/i;
  var PAYLOAD_MAX_BYTES = 200 * 1024;
  function isPayloadPath(p) {
    return PAYLOAD_PATH_RE.test(p) && !PAYLOAD_SKIP_RE.test(p) &&
      (PAYLOAD_EXT_RE.test(p) || p.split('/').pop().indexOf('.') === -1);
  }
  function payloadSizeOk(f) { return f.size > 0 && f.size <= PAYLOAD_MAX_BYTES; }
  var SESSION_HINT = 'No sessions found there. Pick your "~/.claude" folder (Claude Code) or ' +
    '"~/Library/Application Support/Claude/local-agent-mode-sessions" (Cowork). ' +
    'Hidden folders: press Cmd+Shift+. in the file picker, or drag the folder onto this page.';

  function importSessionEntries(entries) {
    if (!entries.length) { toast(SESSION_HINT, true); return; }
    showProgress('Scanning ' + entries.length + ' session files…', 2);
    runImportWorker({ sessionFiles: entries }, 'sessions folder');
  }

  function importSessionFileList(fileList) {
    var entries = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var p = f.webkitRelativePath || f.name;
      if (SESSION_PATH_RE.test(p) || (isPayloadPath(p) && payloadSizeOk(f))) entries.push({ path: p, file: f });
    }
    importSessionEntries(entries);
  }

  /* drag-dropped directory: walk FileSystemEntry tree. outputs/uploads are WALKED since v1.21.0
     (they carry recoverable file text); still pruned: session housekeeping dirs + Office-unpack
     guts + media/deps (nothing text-recoverable there, and they hold thousands of entries) */
  var PRUNE_DIR_RE = /^(backups|tasks|node_modules|\.git|unpacked[^/]*|word|xl|ppt|docProps|customXml|_rels|media|dist|build|\.next|coverage)$/;
  function collectEntries(entries, cb) {
    var out = [], pending = 1;
    function fin() { if (--pending === 0) cb(out); }
    function walk(entry, path) {
      if (entry.isFile) {
        var p = path + entry.name;
        var pay = !SESSION_PATH_RE.test(p) && isPayloadPath(p);
        if (!SESSION_PATH_RE.test(p) && !pay) return;
        pending++;
        entry.file(function (f) {
          if (pay && !payloadSizeOk(f)) { fin(); return; }
          out.push({ path: p, file: f }); fin();
        }, fin);
      } else if (entry.isDirectory) {
        if (PRUNE_DIR_RE.test(entry.name)) return;
        var reader = entry.createReader();
        pending++;
        (function readBatch() { /* readEntries returns results in batches of ~100 — drain it */
          reader.readEntries(function (ents) {
            if (!ents.length) { fin(); return; }
            for (var i = 0; i < ents.length; i++) walk(ents[i], path + entry.name + '/');
            readBatch();
          }, fin);
        })();
      }
    }
    for (var i = 0; i < entries.length; i++) walk(entries[i], '');
    fin();
  }

  /* ---------- Reader ---------- */
  /* model slug → display form: strip a trailing date stamp (claude-haiku-4-5-20251001 → claude-haiku-4-5);
     leave gpt-4o / claude-opus-4-8 as-is. Cleaned-slug style (Eugen's pick) — honest, no lookup table. */
  function cleanModel(m) { return String(m || '').replace(/-\d{6,8}$/, ''); }
  function openReader(uuid, docIdx, opts) {
    /* accepts a uuid OR a transient conversation object (me.skill preview) */
    var c = typeof uuid === 'object' && uuid !== null ? uuid : state.convs.get(uuid);
    if (!c) return;
    uuid = c.uuid;
    state.readerConv = c;
    var terms = parseQueryGroups(state.query.trim()).reduce(function (acc, g) { return acc.concat(highlightTerms(g)); }, []);
    /* include the words the index actually matched (fuzzy/prefix expansions) so they highlight too */
    (state.matchedTerms || []).forEach(function (t) { if (terms.indexOf(t) < 0) terms.push(t); });
    $('#reader-title').textContent = c.name;
    var src = c.source || 'claude';
    var uniqueFiles = (c.fileNames || []).filter(function (n, ix, arr) { return arr.indexOf(n) === ix; });
    var modelStr = (c.models && c.models.length)
      ? c.models.slice(0, 2).map(cleanModel).join(' + ') + (c.models.length > 2 ? ' +' + (c.models.length - 2) : '')
      : ''; /* claude.ai chats carry no model in the export */
    $('#reader-meta').textContent = (c.updated_at || '').slice(0, 10) + ' · ' + c.docs.length + ' messages' +
      (uniqueFiles.length ? ' · \uD83D\uDCCE ' + uniqueFiles.length + ' files' : '') +
      (src === 'project' ? ' · Project knowledge' : (src !== 'claude' ? ' · ' + src + ' session' : '')) +
      (modelStr ? ' · ' + modelStr : '');
    $('#reader-print').style.display = ''; /* Save-PDF available on the conversation reader too (full chats / chats opened at their search matches) */
    var hitDoc = c.docs[docIdx];
    /* claude source → claude.ai deep link; code → claude://resume (desktop app);
       cowork → no working link exists (tested 2026-07-02, §8) — hide instead of faking one */
    var extBtn = $('#reader-ext');
    if (!uuid || uuid.indexOf('demo-') === 0) {
      extBtn.style.display = 'none'; /* generated preview (me.skill / summary, uuid '') or sample conv — no real page to open (honest-links rule §4) */
    } else if (src === 'claude') {
      extBtn.style.display = '';
      extBtn.textContent = 'open on claude.ai ↗';
      extBtn.href = hitDoc ? deepLink(uuid, hitDoc.t, terms).url : 'https://claude.ai/chat/' + encodeURIComponent(uuid);
    } else if (src === 'code') {
      extBtn.style.display = '';
      extBtn.textContent = 'open in Claude app ↗';
      extBtn.href = 'claude://resume?session=' + encodeURIComponent(uuid);
    } else if (src === 'project') {
      extBtn.style.display = '';
      extBtn.textContent = 'open Project on claude.ai ↗';
      extBtn.href = 'https://claude.ai/project/' + encodeURIComponent(uuid);
    } else if (src === 'chatgpt') {
      extBtn.style.display = '';
      extBtn.textContent = 'open on chatgpt.com ↗';
      extBtn.href = 'https://chatgpt.com/c/' + encodeURIComponent(uuid);
    } else {
      extBtn.style.display = 'none';
      extBtn.href = '#';
    }

    /* Find + Pin buttons available on every open conversation */
    $('#reader-find-btn').style.display = '';
    $('#reader-summary-btn').style.display = uuid ? '' : 'none'; /* hide on generated previews (me.skill / summary) */
    updateReaderPin();
    /* print-only "Original chat:" line at the top of a saved PDF, for sources with a stable chat URL */
    var pl = $('#reader-print-link');
    var realUrl = uuid && uuid.indexOf('demo-') !== 0; /* me.skill preview (uuid '') + sample (demo-*) have no real page */
    var purl = realUrl && src === 'claude' ? 'https://claude.ai/chat/' + encodeURIComponent(uuid)
      : realUrl && src === 'chatgpt' ? 'https://chatgpt.com/c/' + encodeURIComponent(uuid) : '';
    if (purl) { pl.textContent = 'Original chat: ' + purl; pl.hidden = false; }
    else { pl.textContent = ''; pl.hidden = true; }
    findReset();

    var html = [];
    for (var i = 0; i < c.docs.length; i++) {
      var d = c.docs[i];
      var body = renderMsgBody(d.t, terms);
      if (d.ty === 'a') {
        var kb = (d.t.length / 1024).toFixed(d.t.length > 10240 ? 0 : 1);
        var open = i === docIdx ? '' : ' collapsed';
        html.push('<div class="msg from-' + d.s + ' att' + open + (i === docIdx ? ' hit' : '') + '" id="rmsg-' + i + '">' +
          '<div class="att-bar"><button class="att-head"><span class="att-caret">\u25B8</span> \uD83D\uDCCE ' + esc(d.fn) +
          ' <span class="att-size">' + kb + ' KB · ' + esc(dNice(d.d)) + '</span></button>' +
          '<button class="att-dl" data-doc="' + i + '" title="Download this file">\u2B07</button></div>' +
          '<div class="msg-text">' + body + '</div></div>');
      } else {
        var who = (d.s === 'h' ? 'you' : 'claude') + ' · ' + esc(dNice(d.d));
        html.push('<div class="msg from-' + d.s + (i === docIdx ? ' hit' : '') + '" id="rmsg-' + i + '">' +
          '<span class="msg-who">' + who + '</span>' +
          '<div class="msg-text">' + body + '</div></div>');
      }
    }
    /* files strip: content-bearing attachments are clickable; name-only files (no text in the export) get an honest "name only" tag */
    var attIdx = {};
    for (var fi = 0; fi < c.docs.length; fi++) {
      if (c.docs[fi].ty === 'a' && !(c.docs[fi].fn in attIdx)) attIdx[c.docs[fi].fn] = fi;
    }
    var seen = {};
    var strip = (c.fileNames || []).filter(function (n) {
      if (seen[n]) return false; seen[n] = 1; return true;
    }).map(function (n) {
      if (n in attIdx) return '<span class="fchip open"><button class="fc-open" data-doc="' + attIdx[n] + '" title="Open here">\uD83D\uDCCE ' + esc(n) + ' <i class="farr">\u2197</i></button><button class="fc-dl" data-doc="' + attIdx[n] + '" title="Download this file">\u2B07</button></span>';
      if (src !== 'claude') return '<span class="fchip dead copyable" data-copy="' + esc(n) + '" title="Click to copy the file name (only the name survived the export \u2014 nothing to open locally).">\uD83D\uDCCE ' + esc(n) + ' <i class="fno">name only</i></span>';
      var frag = encodeURIComponent(n).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
      return '<span class="fchip dead copyable" data-copy="' + esc(n) + '" title="Click to copy the file name.">📎 ' + esc(n) + ' <i class="fno">name only</i> <a class="fno-open" href="https://claude.ai/chat/' + encodeURIComponent(c.uuid) + '#:~:text=' + frag + '" target="_blank" rel="noopener" title="Open the conversation on claude.ai (scrolls to the file when the chat is short enough).">↗</a></span>';
    }).join('');
    $('#reader-files').innerHTML = strip;
    $('#reader-panel').classList.toggle('files-mode', !!(opts && opts.showFiles && strip));
    $('#reader-files-btn').style.display = strip ? '' : 'none';
    updateFilesBtn(uniqueFiles.length);

    $('#reader-body').innerHTML = html.join('');
    $('#reader').classList.add('open');
    document.body.style.overflow = 'hidden';
    var target = document.getElementById('rmsg-' + docIdx);
    if (target) requestAnimationFrame(function () {
      /* deterministic scroll on the known scroller — scrollIntoView on a nested scroller inside a
         fixed overlay is flaky, and it centers the whole message, hiding the match in tall ones.
         Anchor to the first <mark> so we land ON the highlighted term. */
      var scroller = $('#reader-body');
      var anchor = target.querySelector('mark') || target;
      var tr = anchor.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
      scroller.scrollTop += (tr.top - sr.top) - (sr.height / 2 - Math.min(tr.height, sr.height) / 2);
    });
  }

  /* markdown-lite: tables and code fences become real HTML; everything else stays pre-wrapped text */
  function renderMsgBody(text, terms) {
    var hl = function (s) { var e = esc(s); return terms.length ? highlight(e, terms) : e; };
    var lines = text.split('\n');
    var out = [];
    var i = 0;
    var isSep = function (l) { var t = l.trim(); return t.length > 2 && /^[|\s:\-]+$/.test(t) && t.indexOf('-') >= 0; };
    var isRow = function (l) { return l.trim().charAt(0) === '|'; };
    var cells = function (l) {
      var t = l.trim();
      if (t.charAt(0) === '|') t = t.slice(1);
      if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
      return t.split('|').map(function (c) { return c.trim(); });
    };
    while (i < lines.length) {
      var line = lines[i];
      if (line.trim().slice(0, 3) === '```') {
        var code = [];
        i++;
        while (i < lines.length && lines[i].trim().slice(0, 3) !== '```') { code.push(lines[i]); i++; }
        i++; /* closing fence */
        out.push('<div class="codewrap"><button class="codecopy" type="button" aria-label="Copy code">Copy</button><pre class="codeblock">' + hl(code.join('\n')) + '</pre></div>');
        continue;
      }
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && isRow(lines[i]) && !isSep(lines[i])) { rows.push(cells(lines[i])); i++; }
        var t = '<table class="mdtable"><thead><tr>' +
          head.map(function (h) { return '<th>' + hl(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + r.map(function (cell) { return '<td>' + hl(cell) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>';
        out.push(t);
        continue;
      }
      /* plain text: batch consecutive plain lines to keep pre-wrap flow */
      var plain = [line];
      i++;
      while (i < lines.length && lines[i].trim().slice(0, 3) !== '```' &&
             !(isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]))) {
        plain.push(lines[i]); i++;
      }
      out.push(hl(plain.join('\n')));
    }
    return out.join('\n');
  }

  /* ---------- me.skill: distill a personal "about-me" skill, 100% locally ----------
     colloquary has no LLM, so interpretation is deferred to READ-time: the generated
     skill carries curated, redacted EVIDENCE plus instructions telling the consuming
     Claude how to weigh it (corrections = anti-patterns, rituals = standing orders). */
  var MS_STOP = {};
  ('the a an and or but if then else for to of in on at by with from as is are was were be been ' +
   'do does did can could will would should not no yes it its this that these those i you he she ' +
   'we they me my your his her our their them what which who when where how why all any some more ' +
   'most please thanks thank ok okay just so very really let lets also there here now new ' +
   'si sa se ce cu de la un o care este sunt fost pentru din dar daca atunci nu da el ea noi voi ei ' +
   'y la los las es son fue para en con por que und der die das ein eine ist sind war von mit im auf zu ' +
   'et le les une est sont pour avec ' +
   /* common verbs/nouns that carry no personal signal — learned from real-archive eval */
   'have has had need needs needed want wants wanted make makes made making see sees seen saw get gets ' +
   'got go goes going come back same different file files check checked name names first last next new ' +
   'working works worked total number changed change changes only main page pages list use used using ' +
   'added add still well done good time after before again keep put take look looks like maybe think ' +
   'know show run running try tried better best right left top bottom side both other another each every ' +
   'thing things something anything everything work way ways case cases point end start problem issue ' +
   'button click app version test tests line lines code text word words item items ' +
   'error status type display none html data size find found return cannot update mode open read full').split(' ').forEach(function (w) { MS_STOP[w] = 1; });

  /* line-level paste detector: users mix their own words with pasted terminal/log
     output in ONE message — keep the prose lines, drop the machine lines */
  var MS_PASTE_LINE = [
    /^[\w.-]+:[~\w./-]*\s+\w+\s*[›>$%#]/,          /* shell prompt: MacBook-Air-2:~ eugen › */
    /^\s*[$>›#%]\s/,                                 /* bare prompt */
    /^\s*[-d][rwxst-]{9}/,                           /* ls -l */
    /^\s*(total \d|On branch|Your branch|Untracked|nothing to commit|Enumerating|Counting|Compressing|Writing objects|remote:|origin\s|fatal:|error:|warning:|Traceback|File "|at \w+\.|npm (WARN|ERR)|HTTP\/|GET |POST |\d+ files? changed)/i,
    /^\s*[{}\[\]()|+\-=_*;,'"`~<>]{3,}\s*$/,        /* ascii rules / brace lines */
    /^\s*("[\w-]+"\s*:|[\w-]+=[^ ]+$)/,             /* json/env lines */
    /(\/[\w.-]+){3,}/,                               /* deep paths */
    /\b(pid|uid|gid|tcp|udp|systemctl|gunicorn|nginx|psql|SELECT|INSERT|UPDATE \w+ SET)\b/,
    /^(create|delete) mode \d|^Delta compression|^index [0-9a-f]+\.\.|^diff --git|^@@ |^[+-]{3} /i,
    /(command not found|No such file or directory|syntax error near|Permission denied)/,
    /^[\w@.-]+:[~\w/.-]*[#$]\s*$/,                   /* bare remote prompt: root@host:~# */
    /^\s*\{.*\}\s*$/,                                /* one-line JSON */
    /\b(avail|iused|ifree|capacity)\b/i,             /* df/ls table headers */
    /^\w+: warning:/i,                               /* perl: warning: ... */
    /^\s*\d+:/,                                      /* grep -n / numbered dump lines */
    /^(from \w+ import|import \w+|def \w+\(|class \w+[(:])/, /* python source */
    /^\[\d{4}-\d\d-\d\d|\buse --update-env\b|^(Process|PM2\b|\d+\|)/, /* timestamped/pm2 logs */
    /\b\d+%\s+\d+(\.\d+)?\s*[KMG]?B\b/, /* scp/rsync transfer progress: "og.png 100% 60KB 486.3KB/s" (audit F3) */
    /^\[[\w./-]+ [0-9a-f]{7,}\]/,       /* git commit summary "[main bffc8cb] fix: …" — leaked as a design critique (audit cycle 2 §8 F2) */
    /\b(inflating|extracting|deflating):\s|^Archive:\s/, /* zip/unzip output — leaked as a design critique (audit cycle 2 §8 F2) */
    /^\s*✓\s/,                                          /* vitest/jest passing-test rows — leaked as the "15 lib tests" ritual (v1.46.1, merged-skill QA) */
    /\b(sent|received) \d+ bytes\b|\bspeedup is \d/,    /* rsync transfer summary — leaked as the "bytes sec total size is" ritual (v1.46.1) */
    /\bctrl\+?\w* to (expand|toggle|interrupt)\b/i      /* Claude Code UI chrome pasted with output — leaked as the "ctrl to expand" ritual (v1.46.1) */
  ];
  var MS_LABEL_NOISE = /^\[(INFO|WARN(ING)?|ERROR|DEBUG|TRACE|NOTICE|OK|A-Z|0-9|UUID|TAILING|SAVE|OPTIONS|DB(_PATH)?|PM2)\]$/;

  function msCodeSyms(ln) { var m = ln.match(/[=<>{};:#()]/g); return m ? m.length : 0; }

  function msProse(text) {
    /* the export mangles filenames into [x.py](http://x.py) links — unwrap first */
    text = text.replace(/\[([^\]]+)\]\(http[^)]+\)/g, '$1');
    /* users type their comment FIRST, then paste output below it — once a paste
       line appears, everything after it is machine territory: stop there */
    var kept = [];
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln.trim()) continue;
      var paste = (ln.length > 180 && ln.split(' ').length < ln.length / 12) || /* minified/log */
                  msCodeSyms(ln) >= 3 || /^\s*<[!/a-z]/i.test(ln);              /* code / markup */
      for (var j = 0; !paste && j < MS_PASTE_LINE.length; j++) if (MS_PASTE_LINE[j].test(ln)) paste = true;
      if (paste) break;
      kept.push(ln.trim());
    }
    return kept.join(' ').replace(/\s+/g, ' ').trim();
  }

  function msRedact(s) {
    return s
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[ip]')
      .replace(/\+?\d[\d\s\-()]{7,}\d/g, '[number]')
      .replace(/\b(sk|pk|ghp|xox[bap]|AKIA)[A-Za-z0-9_\-]{8,}/g, '[key]')
      .replace(/(password|parola|passwd|pwd)\s*[:=]\s*\S+/gi, '$1: [redacted]');
  }

  function msNorm(t) { return fold(t.toLowerCase()).replace(/\s+/g, ' ').trim(); }

  /* v2 pivot detectors (prototyped in proto_v2.js vs real sessions, 2026-07-03) — precision-first:
     ambiguous cases are dropped, never guessed. */
  var PV_NEG = /\b(no|nope|not|wrong|don'?t|stop|revert|undo|broken|worse|still (the )?same|its the same|same (thing|problem|error)|not happy|nu(-i| e| merge)?|greșit|gresit)\b/i;
  var PV_POS = /\b(good|great|nice|perfect|excellent|works|working|ok(ay)?|done|super|bravo|excelent|merge|mul(t|ț)umesc|mersi|thanks|thank you)\b/i;
  var PV_OPTLINE = /^\s*(\d+[.)]|[a-c][.)]|- |\* )\s*\S/m;
  var PV_ORQ = /\b(or|sau)\b[^.\n]{0,60}\?/i;
  /* a real pick references an option: yes/no, ordinal, number, both/neither, keep/skip/next… */
  var PV_PICK = /\b(yes|yep|yeah|no|nope|ok(ay)?|first|second|third|last|both|neither|all|none|keep|go|skip|option|later|next|then|now|da|nu|prim(a|ul)|ambele|amandoua|niciuna|\d+)\b/i;
  function pvMins(a, b) { var x = Date.parse(a || ''), y = Date.parse(b || ''); return x && y ? (y - x) / 60000 : null; }
  function pvLine(t, n) { var l = t.split('\n').find(function (x) { return x.trim(); }) || ''; return msRedact(l.trim()).slice(0, n || 110); }
  function pvMedian(arr) { if (!arr.length) return 0; arr.sort(function (a, b) { return a - b; }); return arr[Math.floor(arr.length / 2)]; }
  function pvClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  /* does this human doc count as an authored message? (shared by pre-pass + main pass) */
  function msAuthored(d) {
    if (d.s !== 'h' || d.ty === 'a') return null;
    /* scheduled-task prompts are the robot's voice, not the user's */
    if (/^This is an automated run of a scheduled task/i.test(d.t)) return null;
    var prose = msProse(d.t);
    if (prose.length < 15 || prose.length > 1200 || d.t.indexOf('```') >= 0) return null;
    return prose;
  }
  /* adaptive gates: length thresholds scale from THIS archive's median authored message,
     not Eugen-tuned constants (ratios calibrated to reproduce the original values on a
     median of ~68 chars / ~12 words; clamps stop degenerate archives from exploding them) */
  function msGates(list) {
    list = list || state.convs; /* scoped me.skill passes a filtered conv ARRAY; default = whole archive (Map) */
    var chars = [], words = [];
    list.forEach(function (c) {
      for (var i = 0; i < c.docs.length; i++) {
        var prose = msAuthored(c.docs[i]);
        if (prose === null) continue;
        chars.push(prose.length);
        words.push(prose.split(/\s+/).length);
      }
    });
    var mc = pvMedian(chars) || 68, mw = pvMedian(words) || 12;
    /* ceil, not round: gates are upper bounds — rounding DOWN at a boundary silently
       drops evidence one word longer (lost a good critique delta in the 2026-07-03 A/B) */
    return {
      medianChars: mc, medianWords: mw,
      critWords: pvClamp(Math.ceil(1.6 * mw), 12, 40),   /* was 20 */
      pickWords: pvClamp(Math.ceil(1.25 * mw), 10, 30),  /* was 15 */
      accWords: pvClamp(Math.ceil(0.67 * mw), 5, 16),    /* was 8 */
      corrChars: pvClamp(Math.ceil(2.6 * mc), 120, 400), /* was 180 */
      terseChars: pvClamp(Math.ceil(0.9 * mc), 40, 120), /* was 60 */
      repChars: pvClamp(Math.ceil(1.3 * mc), 60, 200)    /* was 90 */
    };
  }

  /* derived acceptance/rejection vocabulary (backlog §11b) — language-agnostic:
     accept-words = words OVERREPRESENTED in short conversation-ENDING replies (lift = rate
     in enders / rate in all authored messages — filters glue words statistically, so we
     don't need a per-language stop list); reject-words = words overrepresented in short
     fast replies that made the assistant REDO its previous message (retry ≈ rejected,
     measured by distinctive-word overlap — behavioral, no lexicon). Derived sets are
     UNION'd with the EN+RO seed regexes: derived never removes, only extends. */
  function msWordsOf(t) { return msNorm(t).match(/[a-z0-9à-ɏ]{2,}/g) || []; }
  /* derive-candidate hygiene (audit F1, v1.25.1): polarity vocabulary must be WORDS — size
     fragments ("2kb"), pixel/dimension shards and 2-letter tokens carry no accept/reject signal
     and cascade into false critique deltas via pvNeg */
  function msDeriveOk(w) { return w.length >= 3 && !/\d/.test(w); }
  function msSimAB(a, b) { /* distinctive-word overlap of two texts, 0..1 */
    var A = {}, na = 0, B = {}, nb = 0, inter = 0;
    msWordsOf(a.slice(0, 800)).forEach(function (w) { if (w.length >= 4 && !MS_STOP[w] && !A[w]) { A[w] = 1; na++; } });
    msWordsOf(b.slice(0, 800)).forEach(function (w) { if (w.length >= 4 && !MS_STOP[w] && !B[w]) { B[w] = 1; nb++; if (A[w]) inter++; } });
    var m = Math.min(na, nb);
    return m >= 3 ? inter / m : 0;
  }
  function msDeriveVocab(G, list) {
    list = list || state.convs; /* scoped me.skill: derive vocab from the SCOPED archive too */
    var df = {}, total = 0;                    /* word -> #authored msgs containing it */
    var endCount = {}, endChats = {}, enders = 0;
    var rejCount = {}, rejChats = {}, rejReplies = 0;
    list.forEach(function (c) {
      for (var i = 0; i < c.docs.length; i++) {
        var prose = msAuthored(c.docs[i]);
        if (prose === null) continue;
        total++;
        var seen = {};
        msWordsOf(prose).forEach(function (w) { if (!seen[w]) { seen[w] = 1; df[w] = (df[w] || 0) + 1; } });
      }
      /* conv ender: archive closes on a short human reaction to an assistant turn */
      var turns = c.docs.filter(function (x) { return x.ty !== 'a'; });
      var L = turns.length - 1;
      if (L >= 1 && turns[L].s === 'h' && turns[L - 1].s === 'a') {
        var e = msProse(turns[L].t);
        if (e && e.split(/\s+/).length <= G.accWords) {
          enders++;
          var seenE = {};
          msWordsOf(e).forEach(function (w) {
            if (seenE[w] || !msDeriveOk(w)) return;
            seenE[w] = 1;
            endCount[w] = (endCount[w] || 0) + 1;
            (endChats[w] = endChats[w] || {})[c.name] = 1;
          });
        }
      }
    });
    var nkc = function (o) { return Object.keys(o).length; };
    var lift = function (w, hits, n) { /* rate in section / rate in all authored */
      return (hits / Math.max(1, n)) / ((df[w] || 1) / Math.max(1, total));
    };
    var accept = {};
    Object.keys(endChats).filter(function (w) { return nkc(endChats[w]) >= 2 && lift(w, endCount[w], enders) >= 3; })
      .sort(function (a, b) { return nkc(endChats[b]) - nkc(endChats[a]) || endCount[b] - endCount[a]; })
      .slice(0, 15).forEach(function (w) { accept[w] = nkc(endChats[w]); });
    /* reject pass needs accept first: acceptance-tinged replies are not rejection evidence.
       accCo tracks how often each word rides ALONGSIDE acceptance evidence in short replies —
       a word's dominant polarity wins ("patched ok" ×15 must keep "patched" out of reject
       even if "patched, still same" appears twice; 2026-07-03 A/B regression). */
    var accCo = {};
    var isPosish = function (ws, u) { return PV_POS.test(u) || ws.some(function (w) { return accept[w]; }); };
    list.forEach(function (c) {
      var turns = c.docs.filter(function (x) { return x.ty !== 'a'; });
      for (var i = 0; i + 1 < turns.length; i++) {
        if (turns[i].s !== 'a' || turns[i + 1].s !== 'h') continue;
        var u = msProse(turns[i + 1].t);
        if (!u || u.split(/\s+/).length > G.critWords) continue;
        var ws = msWordsOf(u);
        if (isPosish(ws, u)) { /* acceptance-tinged: count co-occurrences, not rejections */
          var seenA = {};
          ws.forEach(function (w) { if (!seenA[w]) { seenA[w] = 1; accCo[w] = (accCo[w] || 0) + 1; } });
          continue;
        }
        if (i + 2 >= turns.length || turns[i + 2].s !== 'a') continue;
        var gap = pvMins(turns[i].d, turns[i + 1].d);
        if (gap !== null && gap > 10) continue;
        if (msSimAB(turns[i].t, turns[i + 2].t) < 0.5) continue; /* assistant didn't redo = not a rejection */
        rejReplies++;
        var seenR = {};
        ws.forEach(function (w) {
          if (seenR[w] || !msDeriveOk(w)) return;
          seenR[w] = 1;
          rejCount[w] = (rejCount[w] || 0) + 1;
          (rejChats[w] = rejChats[w] || {})[c.name] = 1;
        });
      }
    });
    var reject = {};
    Object.keys(rejChats).filter(function (w) {
      return !accept[w] && nkc(rejChats[w]) >= 2 && rejCount[w] > (accCo[w] || 0) &&
             lift(w, rejCount[w], rejReplies) >= 3;
    })
      .sort(function (a, b) { return nkc(rejChats[b]) - nkc(rejChats[a]) || rejCount[b] - rejCount[a]; })
      .slice(0, 15).forEach(function (w) { reject[w] = nkc(rejChats[w]); });
    return { accept: accept, reject: reject, enders: enders, rejReplies: rejReplies };
  }

  function buildProfilePack(list, relevant, opts) {
    /* scoped me.skill (v1.25.0): list = filtered conv array (dossier rule) — gates + vocab recalibrate
       to the SCOPE. `relevant(text)` = optional per-recipe keyword predicate (compile-a-skill): keeps only
       patterns whose text is on-topic (drops universal rituals + off-topic deltas). `opts.cand` raises the
       per-section caps — currently UNUSED (kept for a future better-model re-rank; the semantic scorer that
       used it was removed 2026-07-10, e5 too compressed). Default me.skill passes neither → 12-cap, unfiltered. */
    list = list || state.convs;
    var CAP = (opts && opts.cand) || 12;
    var G = msGates(list); /* adaptive length gates from this archive's own median */
    var V = msDeriveVocab(G, list); /* archive-derived accept/reject words (union'd with seeds) */
    var pvHit = function (u, set) { var ws = msWordsOf(u); for (var i = 0; i < ws.length; i++) if (set[ws[i]]) return true; return false; };
    var pvPos = function (u) { return PV_POS.test(u) || pvHit(u, V.accept); };
    var pvNeg = function (u) { return PV_NEG.test(u) || pvHit(u, V.reject); };
    var authored = []; /* {t: prose-only redacted text, chat, date, opener} */
    var convCount = 0, minDate = '9999', maxDate = '';
    var labChats = {}, labCount = {};
    var fnChats = {}, fnCount = {};
    var critiques = [], seenCrit = {};
    var decisions = [], seenDec = {};
    var accCount = {}, accChats = {};
    list.forEach(function (c) {
      convCount++;
      var first = true;
      /* attachment-name patterns are rituals too (HANDOVER_*.md across 59 chats…) */
      var seenFn = {};
      (c.fileNames || []).forEach(function (fn) {
        if (fn === '(pasted text)') return; /* audit F4: placeholder, not a naming ritual (coach already excludes it) */
        var pat = fn.replace(/\d+/g, '#');
        if (seenFn[pat]) return;
        seenFn[pat] = 1;
        fnCount[pat] = (fnCount[pat] || 0) + 1;
        (fnChats[pat] = fnChats[pat] || {})[c.name] = 1;
      });
      for (var i = 0; i < c.docs.length; i++) {
        var d = c.docs[i];
        /* label conventions are conversation-level — scan BOTH sides + attachments */
        (d.t.match(/\[[A-Z][A-Z0-9 _\-]{1,14}\]/g) || []).forEach(function (lab) {
          if (MS_LABEL_NOISE.test(lab)) return; /* log levels aren't conventions */
          labCount[lab] = (labCount[lab] || 0) + 1;
          (labChats[lab] = labChats[lab] || {})[c.name] = 1;
        });
        var prose = msAuthored(d); /* null for assistant docs, attachments, robot prompts, paste-heavy */
        if (prose === null) continue;
        if (d.d && d.d < minDate) minDate = d.d;
        if (d.d && d.d > maxDate) maxDate = d.d;
        authored.push({ t: msRedact(prose), chat: c.name, date: d.d, opener: first });
        first = false;
      }
      /* v2 pivots: reactions in adjacent turns (attachments excluded so turns really are adjacent) */
      var turns = c.docs.filter(function (x) { return x.ty !== 'a'; });
      for (var pi = 0; pi + 1 < turns.length; pi++) {
        if (turns[pi].s !== 'a' || turns[pi + 1].s !== 'h') continue;
        var u = msProse(turns[pi + 1].t);
        if (!u) continue;
        var uw = u.split(/\s+/).length;
        var un = msNorm(u);
        /* critique delta: short FAST negative reaction, then the corrected retry */
        if (uw <= G.critWords && pvNeg(u) && !pvPos(u) && pi + 2 < turns.length && turns[pi + 2].s === 'a' && !seenCrit[un]) {
          var gap = pvMins(turns[pi].d, turns[pi + 1].d);
          if (gap === null || gap <= 10) {
            seenCrit[un] = 1;
            critiques.push({ said: msRedact(u), rejected: pvLine(turns[pi].t), retry: pvLine(turns[pi + 2].t), chat: c.name, date: (turns[pi + 1].d || '').slice(0, 10) });
          }
        }
        /* acceptance marker: very short positive close */
        if (uw <= G.accWords && pvPos(u) && !pvNeg(u)) {
          accCount[un] = (accCount[un] || 0) + 1;
          (accChats[un] = accChats[un] || {})[c.name] = 1;
        }
        /* decision precedent: assistant offered visible options, user picked with pick-words;
           a reply carrying data (emails/IPs/keys → redaction tokens) is an ANSWER, not a pick */
        if (uw <= G.pickWords && !/\?\s*$/.test(u) && turns[pi].t.indexOf('?') >= 0 && PV_PICK.test(u) &&
            msRedact(u) === u &&
            (PV_OPTLINE.test(turns[pi].t) || PV_ORQ.test(turns[pi].t))) {
          var ql = (turns[pi].t.split('\n').filter(function (l) { return l.indexOf('?') >= 0; }).pop() || '').trim();
          var qn = msNorm(ql).slice(0, 60);
          if (ql && !seenDec[qn]) {
            seenDec[qn] = 1;
            decisions.push({ q: msRedact(ql).slice(0, 120), pick: msRedact(u), chat: c.name, date: (turns[pi + 1].d || '').slice(0, 10) });
          }
        }
      }
    });
    if (relevant) { /* recipe pattern-relevance filter: keep only on-topic deltas/precedents */
      /* v1.39.2: match a delta on the USER's reaction line only — the assistant's rejected/retry
         paragraphs carry stray keywords that dragged off-topic deltas through (a deploy delta leaked
         into design via "mobile"). Decisions keep q+pick: the assistant's QUESTION is the fork's topic. */
      critiques = critiques.filter(function (x) { return relevant(x.said); });
      decisions = decisions.filter(function (x) { return relevant(x.q + ' ' + x.pick); });
    }
    var minChats = Math.min(4, Math.max(2, Math.round(convCount / 25)));

    var gramChats = {}, gramCount = {}, gramEx = {}, gramOpen = {};
    var repChats = {}, repCount = {}, repEx = {};
    var wordChats = {}, wordCount = {};
    var corrections = [], seenCorr = {};
    var greets = 0, pleases = 0, questions = 0, nonAscii = 0, lettersTotal = 0;
    var lens = [];
    var corrStartRe = /^(no[,.\s]|nope|don'?t\b|do not\b|stop\b|wrong\b|not like|instead\b|actually[, ]|always\b|never\b|nu[,.\s]|nu asa|greșit|gresit|fără|fara\b|te rog nu)/i;
    var corrCueRe = /\b(you|your|dont|don'?t|stop|instead|keep|always|never|just|wrong|wanted|asked|said)\b/i;
    var distinctive = function (w) { return !MS_STOP[w] && (w.length >= 5 || /\d/.test(w)); };

    authored.forEach(function (m) {
      var norm = msNorm(m.t);
      var toks = (norm.match(/[a-z0-9À-ɏ][a-z0-9À-ɏ_.\-]+/g) || [])
        .map(function (w) { return w.replace(/[._\-]+$/, ''); }); /* wait. === wait */
      lens.push(m.t.length);
      if (/^(hi|hey|hello|salut|hola|buna|bună)\b/i.test(m.t)) greets++;
      if (/\b(please|pls|thanks|thank you|multumesc|mulțumesc|te rog|gracias|merci|danke)\b/i.test(m.t)) pleases++;
      if (m.t.indexOf('?') >= 0) questions++;
      for (var ci = 0; ci < m.t.length; ci++) {
        var ch = m.t[ci];
        if (/[a-zA-ZÀ-ɏ]/.test(ch)) { lettersTotal++; if (ch.charCodeAt(0) > 127) nonAscii++; }
      }
      /* rituals: 3-5-gram phrases anchored by at least one distinctive word */
      for (var n = 3; n <= 5; n++) {
        for (var i = 0; i + n <= toks.length; i++) {
          var ws = toks.slice(i, i + n);
          if (!ws.some(distinctive)) continue;
          var g = ws.join(' ');
          gramCount[g] = (gramCount[g] || 0) + 1;
          (gramChats[g] = gramChats[g] || {})[m.chat] = 1;
          gramEx[g] = gramEx[g] || m;
          if (m.opener) gramOpen[g] = (gramOpen[g] || 0) + 1; /* fix 5: opener-share per phrase */
        }
      }
      /* corrections: pushback starter + a cue that it's aimed at the assistant (or terse) */
      if (m.t.length < G.corrChars && corrStartRe.test(m.t.trim()) &&
          (m.t.length < G.terseChars || corrCueRe.test(m.t)) && !seenCorr[norm]) {
        seenCorr[norm] = 1; corrections.push(m);
      }
      /* (corrections are diversity-capped per chat at selection time — see below) */
      if (m.t.length < G.repChars && norm.length > 8 && msCodeSyms(m.t) < 2) {
        repCount[norm] = (repCount[norm] || 0) + 1;
        (repChats[norm] = repChats[norm] || {})[m.chat] = 1;
        repEx[norm] = repEx[norm] || m;
      }
      var seenW = {};
      toks.forEach(function (w) {
        if (w.length < 4 || MS_STOP[w] || seenW[w] || /^(http|https|www|com|email|number|users?|ip)$/.test(w) || /^\d+$/.test(w)) return;
        seenW[w] = 1;
        wordCount[w] = (wordCount[w] || 0) + 1;
        (wordChats[w] = wordChats[w] || {})[m.chat] = 1;
      });
    });

    if (relevant) corrections = corrections.filter(function (m) { return relevant(m.t); });
    var nk = function (o) { return Object.keys(o).length; };
    var rituals = Object.keys(gramChats).filter(function (g) {
      return nk(gramChats[g]) >= Math.max(3, minChats) && gramCount[g] >= Math.max(3, minChats);
    }).sort(function (a, b) {
      return nk(gramChats[b]) - nk(gramChats[a]) || b.split(' ').length - a.split(' ').length || gramCount[b] - gramCount[a];
    });
    if (relevant) rituals = rituals.filter(function (g) {
      if (/\.(ts|tsx|js|jsx|mjs|cjs|py|md|json|css|scss|html|sh|sql|ya?ml|test)\b/i.test(g)) return false; /* pasted test/code output, not a phrase (v1.39.2) */
      if (relevant(g)) return true; /* the phrase itself is on-topic */
      /* audit-cycle-2 fix 5 (v1.42.0): example-rescue re-admitted UNIVERSAL rituals — any single
         on-topic example brought "lets resume read all" back into every technical recipe. Rescue via
         the example is now only for MID-CONVERSATION phrases ("need to adjust" + its design example);
         opener-dominated phrases describe how chats START, not the topic — no rescue. */
      var openerish = (gramOpen[g] || 0) / gramCount[g] > 0.5;
      return !openerish && relevant(g + ' ' + (gramEx[g] ? gramEx[g].t : ''));
    });
    var kept = [], seenQ = {};
    for (var ri = 0; ri < rituals.length && kept.length < CAP; ri++) {
      var g = rituals[ri], q = gramEx[g].t.slice(0, 160);
      if (seenQ[q]) continue;
      if (kept.some(function (k) { return k.phrase.indexOf(g) >= 0 || g.indexOf(k.phrase) >= 0; })) continue;
      seenQ[q] = 1;
      kept.push({ phrase: g, times: gramCount[g], chats: nk(gramChats[g]), ex: gramEx[g] });
    }
    /* qualifying sets captured PRE-cap so the pack can say "top N of M" (audit F5 — a reading
       LLM weights 12-of-13 very differently from 12-of-90) */
    var repQ = Object.keys(repCount).filter(function (k) { return repCount[k] >= 3 && nk(repChats[k]) >= 2; });
    if (relevant) repQ = repQ.filter(function (k) { return relevant(k); });
    var repeats = repQ
      .sort(function (a, b) { return nk(repChats[b]) - nk(repChats[a]) || repCount[b] - repCount[a]; }).slice(0, CAP)
      .map(function (k) { return { msg: k, times: repCount[k], chats: nk(repChats[k]) }; });
    var labQ = Object.keys(labCount).filter(function (l) { return nk(labChats[l]) >= 3; });
    var labels = labQ
      .sort(function (a, b) { return nk(labChats[b]) - nk(labChats[a]) || labCount[b] - labCount[a]; }).slice(0, 12)
      .map(function (l) { return { label: l, times: labCount[l], chats: nk(labChats[l]) }; });
    var vocabQ = Object.keys(wordCount).filter(function (w) { return nk(wordChats[w]) >= Math.max(5, minChats); });
    var vocab = vocabQ
      .sort(function (a, b) { return nk(wordChats[b]) - nk(wordChats[a]) || wordCount[b] - wordCount[a]; }).slice(0, 25)
      .map(function (w) { return { word: w, times: wordCount[w], chats: nk(wordChats[w]) }; });
    var fnQ = Object.keys(fnCount).filter(function (p) { return nk(fnChats[p]) >= 3; });
    var filenames = fnQ
      .sort(function (a, b) { return nk(fnChats[b]) - nk(fnChats[a]) || fnCount[b] - fnCount[a]; }).slice(0, 8)
      .map(function (p) { return { pattern: p, times: fnCount[p], chats: nk(fnChats[p]) }; });
    /* audit F2: iteration order ≠ chronology once sources mix (a chatgpt import appends 2022
       chats after 2026 ones) — "recent first" must sort by DATE, not by insertion.
       audit F9 (found by the v1.25.1 A/B): the same prompt pasted to open several chats
       duplicated the list — dedup by normalized text, newest kept */
    var seenOp = {};
    var openers = authored.filter(function (m) { return m.opener && (!relevant || relevant(m.t)); })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); })
      .filter(function (m) { var k = msNorm(m.t).slice(0, 80); if (seenOp[k]) return false; seenOp[k] = 1; return true; })
      .slice(0, CAP);
    lens.sort(function (a, b) { return a - b; });
    var stats = {
      medianLen: lens.length ? lens[Math.floor(lens.length / 2)] : 0,
      greetsPct: Math.round(100 * greets / Math.max(1, authored.length)),
      pleasePct: Math.round(100 * pleases / Math.max(1, authored.length)),
      questionsPct: Math.round(100 * questions / Math.max(1, authored.length)),
      nonAsciiPct: Math.round(100 * nonAscii / Math.max(1, lettersTotal))
    };

    /* v2 winners: newest first (recent behavior beats old), capped — evidence, not a dump */
    var newestFirst = function (a, b) { return (b.date || '').localeCompare(a.date || ''); };
    critiques.sort(newestFirst); decisions.sort(newestFirst);
    var accQ = Object.keys(accCount).filter(function (k) { return accCount[k] >= 2; });
    var acceptance = accQ
      .sort(function (a, b) { return accCount[b] - accCount[a]; }).slice(0, 10)
      .map(function (k) { return { phrase: k, times: accCount[k], chats: nk(accChats[k]) }; });
    /* bare "yes/ok" picks are confirmations, not precedents — fold them into ONE stat
       (still meaningful: bias to action) so informative picks aren't displaced */
    var DEC_FILLER = { yes: 1, yep: 1, yeah: 1, no: 1, nope: 1, ok: 1, okay: 1, sure: 1, please: 1, thanks: 1, da: 1, nu: 1, go: 1, ahead: 1, both: 1, all: 1, now: 1, then: 1, next: 1, first: 1, second: 1, read: 1, start: 1, build: 1, it: 1 };
    var decRich = [], bareApprovals = 0;
    decisions.forEach(function (x) {
      var content = msNorm(x.pick).split(/[^a-z0-9#]+/).filter(function (w) { return w && !DEC_FILLER[w]; });
      if (content.length >= 2) decRich.push(x); else bareApprovals++;
    });
    /* corrections: ≤3 per chat, or one marathon chat drowns the section */
    var corrPerChat = {}, corrOut = [];
    for (var ci2 = 0; ci2 < corrections.length && corrOut.length < CAP; ci2++) {
      var cc = corrections[ci2];
      corrPerChat[cc.chat] = (corrPerChat[cc.chat] || 0) + 1;
      if (corrPerChat[cc.chat] <= 3) corrOut.push(cc);
    }

    return { convs: convCount, authored: authored.length, range: minDate.slice(0, 10) + ' → ' + maxDate.slice(0, 10),
             rituals: kept, corrections: corrOut, repeats: repeats,
             labels: labels, filenames: filenames, vocab: vocab, openers: openers, stats: stats,
             critiques: critiques.slice(0, CAP), decisions: decRich.slice(0, CAP),
             bareApprovals: bareApprovals, acceptance: acceptance, gates: G, derivedVocab: V,
             totals: { rituals: rituals.length, corrections: corrections.length, critiques: critiques.length,
                       decisions: decRich.length, acceptance: accQ.length, repeats: repQ.length,
                       labels: labQ.length, filenames: fnQ.length, vocab: vocabQ.length } };
  }

  function renderMeSkill(name, p, recipe) {
    var today = new Date().toISOString().slice(0, 10);
    var who = (recipe && recipe.person) || name;
    var L = [];
    L.push('---');
    L.push('name: about-' + name);
    L.push('description: ' + (recipe
      ? 'How ' + who + ' approaches ' + recipe.label + ', distilled locally by colloquary from ' + p.convs + ' ' + recipe.label + '-related conversations (' + p.range + ') on ' + today + '. Use this skill when ' + recipe.useWhen + '.'
      : 'Personal working-style context for ' + name + ', distilled locally by colloquary from ' + p.convs + ' real conversations (' + p.range + ')' + (p.scope ? ' — SCOPED to ' + p.scope + ' only' : '') + ' on ' + today + '. Use this skill in EVERY session with this user — before drafting anything, giving instructions, structuring a response, or making assumptions about tools, language, or workflow.'));
    L.push('---', '', '# ' + (recipe ? who + ' — ' + recipe.label : 'Working with ' + name), '');
    if (recipe) L.push(recipe.intro, '');
    L.push('This is machine-distilled EVIDENCE, not interpretation — generated ' + today + ', quotes auto-redacted. Read it like this: **corrections and critique deltas are anti-patterns** (defaults that failed for this user — weight them highest); **rituals and repeated instructions are standing orders** (apply without being asked); **decision precedents set your defaults at forks**; **acceptance markers mean STOP iterating**; labels and vocabulary are their language (use it); anything that looks like a fact (tools, paths, versions) is stamped ' + today + ' and may be stale — verify before relying on it.', '');
    if (recipe) L.push('**Lens:** distilled from a SEMANTIC slice of the archive on "' + recipe.label + '" — how ' + who + ' works in that context; a ranking of the closest conversations, not an exhaustive filter.', '');
    else if (p.scope) L.push('**Scope note:** this pack was distilled from a FILTERED slice of the archive (' + p.scope + ') — it reflects how this user works in that context, not necessarily everywhere.', '');
    var oneline = function (s, n) { return s.replace(/\s+/g, ' ').slice(0, n); };
    /* audit F5: "top N of M" tells the reading LLM how dense the evidence really is */
    var T = p.totals || {};
    var ofN = function (shown, key) { var t = T[key] || 0; return t > shown ? ' (top ' + shown + ' of ' + t + ')' : ''; };
    L.push('## Style', '');
    L.push('- median authored message: ' + p.stats.medianLen + ' chars · greets ' + p.stats.greetsPct +
      '% · please/thanks ' + p.stats.pleasePct + '% · questions ' + p.stats.questionsPct +
      '% · non-ASCII letters ' + p.stats.nonAsciiPct + '%');
    L.push('', '## Recurring phrases — phrase · times · distinct chats' + ofN(p.rituals.length, 'rituals'), '');
    p.rituals.forEach(function (r) {
      L.push('- "' + r.phrase + '" · ' + r.times + '× · ' + r.chats + ' chats — e.g. "' + oneline(r.ex.t, 140) + '" (' + oneline(r.ex.chat, 40) + ', ' + r.ex.date + ')');
    });
    L.push('', '## Corrections — treat as anti-patterns' + ofN(p.corrections.length, 'corrections'), '');
    p.corrections.forEach(function (m) {
      L.push('- "' + oneline(m.t, 140) + '" (' + oneline(m.chat, 40) + ', ' + m.date + ')');
    });
    if (p.critiques && p.critiques.length) {
      L.push('', '## Critique deltas — a rejected assistant move, their exact words, the accepted retry' + ofN(p.critiques.length, 'critiques'), '');
      L.push('Weight these HIGHEST: each is the measured gap between a standard response and what this user accepts. Before showing output, test your draft against them.', '');
      p.critiques.forEach(function (x) {
        L.push('- rejected: "' + oneline(x.rejected, 90) + '" → they said: **"' + oneline(x.said, 90) + '"** → accepted retry: "' + oneline(x.retry, 90) + '" (' + oneline(x.chat, 35) + ', ' + x.date + ')');
      });
    }
    if (p.decisions && p.decisions.length) {
      L.push('', '## Decision precedents — how they choose when offered options' + ofN(p.decisions.length, 'decisions'), '');
      L.push('These picks are DEFAULT-SETTERS: when you offer options, lead with the one matching this pattern; when the fork is minor, just take it and say so.', '');
      p.decisions.forEach(function (x) {
        L.push('- asked: "' + oneline(x.q, 100) + '" → picked: **"' + oneline(x.pick, 80) + '"** (' + oneline(x.chat, 35) + ', ' + x.date + ')');
      });
      if (p.bareApprovals) L.push('- plus ' + p.bareApprovals + ' bare "yes / ok, go" approvals of the assistant\'s proposed next step — strong bias to action: propose, don\'t ask open-ended.');
    }
    if (p.acceptance && p.acceptance.length) {
      L.push('', '## Acceptance markers — what "settled" sounds like' + ofN(p.acceptance.length, 'acceptance'), '');
      L.push('When a reply matches these, the matter is CLOSED: move on, do not re-polish or revisit.', '');
      p.acceptance.forEach(function (a) {
        L.push('- "' + a.phrase + '" · ' + a.times + '× · ' + a.chats + ' chats');
      });
    }
    if (p.repeats.length) { /* v1.46.1 — an empty section header is noise (a merged-skill preview rendered one) */
      L.push('', '## Repeated short instructions' + ofN(p.repeats.length, 'repeats'), '');
      p.repeats.forEach(function (r) { L.push('- "' + oneline(r.msg, 100) + '" · ' + r.times + '× · ' + r.chats + ' chats'); });
    }
    L.push('', '## Label tokens (conversation-level conventions, either side may write them)', '');
    p.labels.forEach(function (l) { L.push('- ' + l.label + ' · ' + l.times + '× · ' + l.chats + ' chats'); });
    L.push('', '## Recurring attachment-name patterns (# = digits)', '');
    p.filenames.forEach(function (f) { L.push('- ' + f.pattern + ' · ' + f.times + '× · ' + f.chats + ' chats'); });
    L.push('', '## Distinctive vocabulary — word (times · chats)', '');
    L.push(p.vocab.map(function (v) { return v.word + ' (' + v.times + '·' + v.chats + ')'; }).join(', '));
    L.push('', '## How chats open (recent first)', '');
    p.openers.forEach(function (m) {
      L.push('- "' + oneline(m.t, 110) + '" (' + oneline(m.chat, 40) + ', ' + m.date + ')');
    });
    var dvA = Object.keys((p.derivedVocab || {}).accept || {}).length, dvR = Object.keys((p.derivedVocab || {}).reject || {}).length;
    L.push('', '_Stats: ' + p.authored + ' authored messages across ' + p.convs + ' conversations. Archive-derived polarity vocab beyond the built-in seeds: +' + dvA + ' accept / +' + dvR + ' reject words. Regenerate quarterly from a fresh export._', '');
    /* what the reading LLM must know NOT to assume (consumer lens, v1.25.1) */
    L.push('_Blind spots, for the assistant reading this: mechanical extraction only — no semantic pass; project-specific rules live in each repo\'s own docs, NOT here (do not expect them); quotes are auto-redacted; sections are capped and "top N of M" shows how much evidence was left out._', '');
    return L.join('\n');
  }

  /* scoped me.skill (v1.25.0) — same rule as the dossier button: an ACTIVE query/filter scopes
     the pack (state.dossier holds that list); a bare source TAB scopes to its source; plain
     browse-all = whole archive. Gates + vocab recalibrate to the scope (see buildProfilePack). */
  function viewScope() { /* shared by me.skill / Stats / Token coach (v1.26.0) */
    if (state.dossier) return { list: state.dossier.convs, label: state.dossier.label };
    var set = srcTabSet();
    if (set) {
      var l = Array.from(state.convs.values()).filter(function (c) { return set[c.source || 'claude']; });
      if (l.length) return { list: l, label: 'source:' + state.srcTabs.join('+') };
    }
    return null;
  }

  /* ---------- compiler: preset recipes (a curated semantic lens + framing per skill) ----------
     The .skill output template = buildProfilePack (shared detectors) scoped by a semantic lens, rendered
     with a recipe-specific framing. v1 uses the SHARED detectors (recipe_model's generic engine ~65-70%);
     bespoke per-recipe detectors (stack extraction, stylometry, polish-term) slot in later. */
  var SKILL_RECIPES = {
    coding: { label: 'coding', lens: 'software development, coding, deployment, git, servers, debugging, build, tests, commands, terminal',
      kw: /\b(cod(e|ing)|deploy(ment|ed)?|git(hub)?|vps|server|hosting|nginx|ssh|build|tests?|bug|fix(ed|es)?|api|function|script|terminal|command|npm|node|python|flask|fastapi|commit|push|pull|database|sql|redis|celery|docker|cache|wasm|css|html|js|json|localhost|port|env|config|debug|error|crash|log|refactor|module|import|export|endpoint|regex|token|schema|migration|pm2|certbot)\b/i,
      intro: 'How this user ships code — their engineering protocol, command conventions, and the anti-patterns to avoid.',
      useWhen: 'writing, changing, testing, or deploying code, or giving terminal commands' },
    design: { label: 'design', lens: 'visual design, UI, layout, spacing, alignment, CSS, mobile, responsive, components, buttons, polish, tidy',
      kw: /\b(design|ui|ux|layout|spacing|space|align(ed|ment)?|center(ed)?|padding|margin|mobile|responsive|css|button|colou?r|font|size|height|width|gap|tidy|neat|pixel|px|screen|visual|component|icon|logo|border|radius|shadow|card|grid|flex|hover|style|theme|position|overflow|wrap|mockup|round(ed)?)\b/i,
      intro: 'How this user judges visual work — their polish bar, layout conventions, and the design anti-patterns to avoid.',
      useWhen: 'proposing or changing anything visual — UI, CSS, layout, or components' },
    writing: { label: 'writing', lens: 'writing style and tone of voice — wording, phrasing, copywriting, taglines, headlines, naming, romanian and english',
      /* audit-cycle-2 fix 4 (v1.42.0): measured 1/8 precision — the old kw's ubiquitous tokens
         (word, text, name, title, copy, message, reply) matched text-PROCESSING all over a software
         corpus (logo geometry, pdf dpi, copy-paste). Rebuilt authoring-only; lens recalibrated
         (audit_compiler.js s12 — candidate C: best 0.885, pulls headline/translation/feedback convs).
         Scope will always be mixed on a technical corpus (writing happens INSIDE work sessions) —
         the kw filter is the measured precision lever, not the lens. */
      kw: /\b(wording|worded|tone|phras(e|ing|ed)|sentence|tagline|slogan|headline|caption|voice|rephras\w*|reword\w*|copywrit\w*|draft(ed|ing)?|grammar|paragraph|prose|concise|romanian|english|translat\w*|naming|renam\w*|formulat\w*)\b/i,
      intro: 'How this user writes — voice, register, and phrasing preferences.',
      useWhen: 'drafting text in this user’s voice — messages, replies, copy, or naming' }
  };
  function recipeSlug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'topic'; }

  /* v1.46.0 — MERGE SKILLS: one skill from 2–3 recipes at COMPILE time (lens union, kw OR) — the
     agreed shape; never post-hoc .skill-file merging, which loses provenance. Pure; test_summary.js. */
  function mergeRecipes(parts) {
    var labels = parts.map(function (p) { return p.label; });
    return {
      label: labels.join(' + '),
      lens: parts.map(function (p) { return p.lens; }).join('; '), /* display fallback — scans run per part */
      parts: parts,
      intro: 'How this user works across ' + labels.join(', ') + ' — one skill merged from the on-topic conversations of each topic.',
      useWhen: parts.map(function (p) { return p.useWhen; }).join('; also when ')
    };
  }

  /* audit cycle 3 (§12) — round-robin the per-part selections into ONE deduped union (cap).
     The old sequential fill + final slice let a broad first part starve the later parts to ZERO
     while the coverage line still showed their pre-cap counts. Pure; test_summary.js.
     Returns { order: [ids], perCount: [n per part — what each part ACTUALLY contributed] }. */
  function mergeFill(sels, cap) {
    var order = [], seen = {}, idxs = sels.map(function () { return 0; });
    var perCount = sels.map(function () { return 0; }), progressed = true;
    while (order.length < cap && progressed) {
      progressed = false;
      for (var pi = 0; pi < sels.length && order.length < cap; pi++) {
        while (idxs[pi] < sels[pi].length) {
          var u = sels[pi][idxs[pi]++];
          if (seen[u]) continue; /* overlap counts for whichever part reached it first */
          seen[u] = 1; order.push(u); perCount[pi]++; progressed = true;
          break;
        }
      }
    }
    return { order: order, perCount: perCount };
  }

  /* preview in the reader + zip + download a .skill (shared by me.skill and compile-a-skill) */
  function deliverSkill(previewName, fullName, md, coverage) {
    var today = new Date().toISOString().slice(0, 10);
    openReader({ uuid: '', name: previewName, created_at: today, updated_at: today, msgCount: 1, schema: SCHEMA, fileNames: [], docs: [{ s: 'a', d: today, t: md }] }, 0);
    var files = {}; files['about-' + fullName + '/SKILL.md'] = fflate.strToU8(md);
    var blob = new Blob([fflate.zipSync(files)], { type: 'application/zip' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'about-' + fullName + ' - ' + today + '.skill'; /* export-naming rule: content + date */
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    /* v1.45.2 — the skill body is assistant-neutral markdown: offer the plain .md for non-Claude
       assistants (ChatGPT knowledge / custom instructions, a Gemini Gem, any system prompt). The
       .skill zip auto-loads only in Claude; the CONTENT travels anywhere. ONE combined toast
       (callers pass their coverage line here instead of toasting over this one) — tap = save .md. */
    toast((coverage ? coverage + ' ' : '') + '.skill downloaded — install in Claude (Settings → Capabilities), or TAP HERE for the plain .md that works with any assistant.');
    /* armed AFTER the toast — toast() voids any previous action (v1.52.0 stale-action rule) */
    state._toastAction = function () {
      var b2 = new Blob([md], { type: 'text/markdown' });
      var a2 = document.createElement('a'); a2.href = URL.createObjectURL(b2);
      a2.download = 'about-' + fullName + ' - ' + today + '.md';
      a2.click();
      setTimeout(function () { URL.revokeObjectURL(a2.href); }, 5000);
      toast('Plain .md saved — add it to a GPT’s knowledge, a Gemini Gem, or any system prompt.');
    };
  }

  /* NOTE (2026-07-10): a semantic pattern-scorer (embed each pattern vs the lens, keep by cosine) was built
     and REMOVED — calibration proved e5's pattern-vs-lens cosines are compressed to ~0.80–0.87 with no
     separation (a git delta 0.82 vs a design delta 0.85), same as the §8 passage finding, and it even brought
     the universal rituals back (they score ~0.83 against every lens). The keyword `relevant` predicate below
     is the better result. A better-separating model (Gemma) or bespoke per-recipe detectors are the real lever. */

  function makeMeSkill() {
    if (!state.convs.size) { toast('Import your export first — the skill is distilled from it.', true); return; }
    var scope = viewScope();
    var name = (window.prompt('First name for the skill (about-<name>):', '') || 'me').toLowerCase().replace(/[^a-z0-9]/g, '') || 'me';
    if (scope) {
      /* the suffix keeps a scoped pack from colliding with the full one on install */
      var slug = scope.label.replace(/^source:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'scoped';
      name = name + '-' + slug;
    }
    var pack = buildProfilePack(scope && scope.list);
    if (scope) pack.scope = scope.label + ' (' + pack.convs + ' of ' + state.convs.size + ' conversations)';
    var md = renderMeSkill(name, pack);
    /* v1.45.2 — unified on deliverSkill: same preview + .skill download + the plain-.md tap-offer
       (the skill body is assistant-neutral — it travels to ChatGPT / Gemini / any system prompt) */
    deliverSkill('me.skill — preview' + (scope ? ' — SCOPED: ' + scope.label : '') + ' (review before installing)', name, md,
      scope ? 'Scoped me.skill — distilled from ' + pack.convs + ' conversations matching ' + scope.label +
        ' (clear the search / click the all tab first if you wanted the whole archive).' :
      'me.skill ready — review the preview; nothing left this browser.');
  }

  /* ---------- Whole-archive export (backup + phone transfer) ----------
     One .zip holding every conversation record (claude + code + cowork), already-normalized
     SCHEMA-N docs. The import worker detects the marker and upserts directly — no re-normalization,
     no SCHEMA bump. Session folders are desktop-only, so this is the ONLY way to get Code/Cowork
     chats onto a phone; it doubles as a backup and device-migration file. Local download, no upload. */
  function buildArchive(convs, schema) {
    return { skillmint_archive: true, schema: schema, exportedAt: new Date().toISOString(), count: convs.length, convs: convs };
  }

  function downloadArchive() {
    if (!state.convs.size) { toast('Nothing to export yet — import your chats first.', true); return; }
    /* v1.28.0: the backup follows the ACTIVE scope like everything else (chips/filter) — but a
       PARTIAL backup must be impossible to mistake for a full one: the scope rides the filename,
       the toast says N of M, and no scope means the full archive exactly as before. */
    var scope = viewScope();
    var convs = [];
    if (scope) scope.list.forEach(function (c) { convs.push(c); });
    else state.convs.forEach(function (c) { convs.push(c); });
    var slug = scope ? scope.label.replace(/^source:/, '').toLowerCase().replace(/[^a-z0-9+]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) : '';
    toast(scope ? 'Packing a PARTIAL archive — ' + scope.label + '…' : 'Packing your archive…');
    setTimeout(function () {
      var json = JSON.stringify(buildArchive(convs, SCHEMA));
      var files = {}; files['colloquary-archive.json'] = fflate.strToU8(json);
      var zip = fflate.zipSync(files);
      var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = 'colloquary-archive-' + (slug ? slug + '-' : '') + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.zip';
      var blob = new Blob([zip], { type: 'application/zip' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      var mb = (zip.length / 1e6).toFixed(1);
      toast('Archive saved — ' + convs.length + ' conversation' + (convs.length > 1 ? 's' : '') +
        (scope ? ' of ' + state.convs.size + ' (' + scope.label + ' — click the all chip and Download again for a FULL backup)' : '') +
        ', ' + mb + ' MB. All message text + text attachments. Local file, nothing uploaded — drop it onto colloquary on another device, incl. your phone.');
    }, 30);
  }

  function closeReader() {
    findReset();
    $('#reader').classList.remove('open');
    $('#reader-panel').classList.remove('files-mode');
    $('#reader-body').innerHTML = '';
    document.body.style.overflow = '';
  }

  /* ---------- Find in conversation (in-reader) ----------
     Highlights matches WITHIN the open conversation and steps between them. Walks #reader-body
     text nodes (never HTML) so the existing search-term <mark>s are untouched and we can't chew
     our own tags; find matches get <mark class="find"> (current = .cur). Diacritic-insensitive via
     the shared termRegex. */
  var findMarks = [], findIdx = -1;
  function findReset() {
    var bar = $('#reader-find'); if (bar) bar.hidden = true;
    var inp = $('#find-input'); if (inp) inp.value = '';
    var cnt = $('#find-count'); if (cnt) cnt.textContent = '0';
    findMarks = []; findIdx = -1;
  }
  function findClear() {
    var body = $('#reader-body'); if (!body) return;
    var ms = body.querySelectorAll('mark.find');
    for (var i = 0; i < ms.length; i++) ms[i].parentNode.replaceChild(document.createTextNode(ms[i].textContent), ms[i]);
    if (ms.length && body.normalize) body.normalize();
    findMarks = []; findIdx = -1;
  }
  function findRun(q) {
    findClear();
    q = (q || '').trim();
    var cnt = $('#find-count');
    if (!q) { if (cnt) cnt.textContent = '0'; return; }
    var re;
    try { re = new RegExp(termRegex(q), 'gi'); } catch (e) { return; }
    var body = $('#reader-body');
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
    var targets = [], node;
    while ((node = walker.nextNode())) { re.lastIndex = 0; if (node.nodeValue && re.test(node.nodeValue)) targets.push(node); }
    for (var t = 0; t < targets.length; t++) {
      var s = targets[t].nodeValue, frag = document.createDocumentFragment(), last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(s))) {
        if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        var mk = document.createElement('mark'); mk.className = 'find'; mk.textContent = m[0];
        frag.appendChild(mk);
        last = m.index + m[0].length;
        if (m.index === re.lastIndex) re.lastIndex++; /* zero-width guard */
      }
      if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
      targets[t].parentNode.replaceChild(frag, targets[t]);
    }
    findMarks = Array.prototype.slice.call(body.querySelectorAll('mark.find'));
    findIdx = findMarks.length ? 0 : -1;
    findPaint();
  }
  function findPaint() {
    for (var i = 0; i < findMarks.length; i++) findMarks[i].classList.toggle('cur', i === findIdx);
    var cnt = $('#find-count');
    if (cnt) cnt.textContent = findMarks.length ? (findIdx + 1) + '/' + findMarks.length : 'none';
    var cur = findMarks[findIdx];
    if (!cur) return;
    /* a match can live inside a COLLAPSED text attachment (its body is display:none) — reveal it so
       the jump lands on something visible instead of silently no-op'ing (Eugen 2026-07-09) */
    var att = cur.closest ? cur.closest('.msg.att.collapsed') : null;
    if (att) att.classList.remove('collapsed');
    if (cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
  }
  function findStep(dir) {
    if (!findMarks.length) return;
    findIdx = (findIdx + dir + findMarks.length) % findMarks.length;
    findPaint();
  }
  function findOpen() {
    if ($('#reader-panel').classList.contains('files-mode')) {
      $('#reader-panel').classList.remove('files-mode');
      updateFilesBtn($('#reader-files-btn').getAttribute('data-n') || '');
    }
    $('#reader-find').hidden = false;
    var inp = $('#find-input'); inp.focus(); inp.select();
    if (inp.value) findRun(inp.value);
  }
  function findClose() {
    findClear();
    $('#reader-find').hidden = true;
    $('#find-count').textContent = '0';
    $('#find-input').value = '';
  }

  function updateFilesBtn(n) {
    var inFiles = $('#reader-panel').classList.contains('files-mode');
    $('#reader-files-btn').textContent = inFiles ? '\u2190 messages' : '\uD83D\uDCCE ' + n + ' files';
    $('#reader-files-btn').setAttribute('data-n', n);
  }

  /* ---------- Stats & How-to-use (\u22EF menu) \u2014 static pages rendered in the reader shell ---------- */
  function openPage(title, meta, html) {
    state.readerConv = null;
    findReset();
    $('#reader-title').textContent = title;
    $('#reader-meta').textContent = meta || '';
    $('#reader-ext').style.display = 'none';
    $('#reader-files-btn').style.display = 'none';
    $('#reader-find-btn').style.display = 'none'; /* find is for conversations, not static pages */
    $('#reader-summary-btn').style.display = 'none';
    $('#reader-pin').style.display = 'none';
    var _pl = $('#reader-print-link'); if (_pl) { _pl.hidden = true; _pl.textContent = ''; }
    $('#reader-print').style.display = '';
    $('#reader-panel').classList.remove('files-mode');
    $('#reader-body').innerHTML = '<div class="page">' + html + '</div>';
    $('#reader').classList.add('open');
    $('#reader-body').scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }

  function fmtDur(min) {
    min = Math.round(min);
    var h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + ' m';
    if (h >= 100) return h.toLocaleString() + ' h';
    return h + ' h ' + (m < 10 ? '0' : '') + m + ' m';
  }

  function fmtK(n) { return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : '' + n; }

  /* whitespace-run counter \u2014 no per-word allocations (runs over ~19 MB of text) */
  function wordCount(t) {
    var n = 0, inw = false;
    for (var i = 0; i < t.length; i++) {
      if (t.charCodeAt(i) <= 32) inw = false;
      else if (!inw) { n++; inw = true; }
    }
    return n;
  }

  function pad2n(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(dt) { return dt.getFullYear() + '-' + pad2n(dt.getMonth() + 1) + '-' + pad2n(dt.getDate()); }

  /* group sorted timestamps into sessions: a gap > gapMs starts a new one; each session
     gets a tailMin allowance (the last message still gets read/acted on) */
  function sessionize(ev, gapMs, tailMin) {
    if (!ev.length) return { mins: 0, n: 0, list: [] };
    ev.sort(function (a, b) { return a - b; });
    var list = [], s0 = ev[0], prev = ev[0], i;
    for (i = 1; i < ev.length; i++) {
      if (ev[i] - prev > gapMs) { list.push([s0, prev]); s0 = ev[i]; }
      prev = ev[i];
    }
    list.push([s0, prev]);
    var mins = 0;
    for (i = 0; i < list.length; i++) mins += (list[i][1] - list[i][0]) / 60000 + tailMin;
    return { mins: mins, n: list.length, list: list };
  }

  function srow(label, frac, valueHtml, alt) {
    return '<div class="srow"><span class="sl" title="' + esc(label) + '">' + esc(label) + '</span>' +
      '<span class="sbar' + (alt ? ' alt' : '') + '" style="width:' + Math.max(1, Math.round(frac * 52)) + '%"></span>' +
      '<span class="sv">' + valueHtml + '</span></div>';
  }

  /* ---------- v1.47.0 ENTITY MAPPING (the footprint index) ----------
     Regex-reliable entities ONLY — domains · IPs · repos · paths — EXTRACTED, never inferred;
     people/emails deliberately excluded (fuzzy without a model = the dishonest trap, Eugen's pick).
     Pure + node-tested (test_entities.js). Click-through = a plain quoted search, so the reader,
     dossier, Stats and the router all follow the same scope for free. */
  function entRules() {
    if (entRules._r) return entRules._r;
    var tlds = 'com net org io dev app cc ai co de ro uk eu me sh xyz tools info cloud host site tech online store fr it es nl at ch us ca'.split(' ');
    /* audit cycle 3 (§13): exact-match deny-list — macOS app bundles + JS property accesses that
       collide with the TLD allowlist (.app/.host/.site/.online). Deny EXACT tokens only; dropping
       the TLDs would kill real domains (sqlalche.me is real). */
    var deny = {};
    ('terminal.app finder.app safari.app chrome.app firefox.app preview.app textedit.app word.app ' +
     'excel.app powerpoint.app notes.app mail.app photos.app numbers.app keynote.app pages.app ' +
     'xcode.app window.app update.app request.host window.host location.host document.host ' +
     'navigator.online p.site product.site').split(' ').forEach(function (d) { deny[d] = 1; });
    entRules._r = {
      deny: deny,
      domain: new RegExp('\\b(?:[a-z0-9][a-z0-9-]{0,62}\\.)+(?:' + tlds.join('|') + ')\\b', 'gi'),
      ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      repo: /\b([\w-]+)\.git\b|\b(?:github|gitlab|bitbucket)\.com\/([\w][\w./-]*)/gi,
      path: /(?:~|\/(?:home|srv|etc|var|usr|opt|Users|sessions))(?:\/[\w.@-]+){1,8}/g
    };
    return entRules._r;
  }
  function entScan(text) {
    var R = entRules(), out = [], m, t = String(text || '');
    R.domain.lastIndex = 0;
    while ((m = R.domain.exec(t))) {
      var dv = m[0].toLowerCase();
      if (!R.deny[dv]) out.push({ k: 'domain', v: dv });
    }
    R.ip.lastIndex = 0;
    while ((m = R.ip.exec(t))) {
      if (m[0].split('.').every(function (o) { return +o <= 255; })) out.push({ k: 'ip', v: m[0] });
    }
    R.repo.lastIndex = 0;
    while ((m = R.repo.exec(t))) {
      var v = m[1] ? m[1].toLowerCase() + '.git'
        : m[2].split('/').slice(0, 2).join('/').replace(/\.git$/i, '').replace(/[.,;:]+$/, '').toLowerCase();
      if (v && v.indexOf('/') !== 0) out.push({ k: 'repo', v: v });
    }
    R.path.lastIndex = 0;
    while ((m = R.path.exec(t))) {
      var segs = m[0].split('/').filter(function (s) { return s !== ''; });
      out.push({ k: 'path', v: (m[0].charAt(0) === '/' ? '/' : '') + segs.slice(0, 3).join('/') });
    }
    return out;
  }
  /* aggregate a conversation list → per kind, ranked {v, times, chats, first, last}; an entity in
     only ONE conversation is a mention, not footprint — dropped */
  function entIndex(list) {
    var acc = { domain: {}, ip: {}, repo: {}, path: {} };
    list.forEach(function (c) {
      (c.docs || []).forEach(function (d) {
        var day = (d.d || '').slice(0, 10);
        entScan(d.t).forEach(function (e) {
          var s = acc[e.k][e.v] || (acc[e.k][e.v] = { v: e.v, times: 0, chats: 0, seen: {}, months: {}, first: '', last: '' });
          s.times++;
          s.seen[c.uuid] = (s.seen[c.uuid] || 0) + 1; /* v1.48.2 — mentions PER conversation (feeds the hover card's top-convs; still truthy for entCoocc) */
          if (s.seen[c.uuid] === 1) s.chats++;
          if (day) {
            var mon = day.slice(0, 7);
            s.months[mon] = (s.months[mon] || 0) + 1; /* v1.48.0 — feeds the per-entity sparkline */
            if (!s.first || day < s.first) s.first = day;
            if (day > s.last) s.last = day;
          }
        });
      });
    });
    var out = {};
    Object.keys(acc).forEach(function (k) {
      out[k] = Object.keys(acc[k]).map(function (v) { return acc[k][v]; }) /* seen kept — entCoocc needs the chat sets (page-lifetime only) */
        .filter(function (s) { return s.chats >= 2; })
        .sort(function (a, b) { return b.chats - a.chats || b.times - a.times; });
    });
    return out;
  }
  /* v1.48.0 — ONE month axis for the whole page (every sparkline shares the same time scale, so
     rows compare visually) */
  function entAxis(rows) {
    var lo = '', hi = '';
    rows.forEach(function (r) {
      if (!r.first) return;
      var a = r.first.slice(0, 7), b = r.last.slice(0, 7);
      if (!lo || a < lo) lo = a;
      if (b > hi) hi = b;
    });
    if (!lo) return [];
    var out = [], y = +lo.slice(0, 4), m = +lo.slice(5, 7);
    while (out.length <= 120) {
      var k = y + '-' + (m < 10 ? '0' : '') + m;
      out.push(k);
      if (k === hi) break;
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }
  /* v1.48.0 — "appears with": entities sharing ≥2 conversations, the cross-reference map. Substring
     pairs skipped (www.example.com vs example.com / project.git vs /srv/git/project.git tell you nothing new). */
  function entCoocc(rows) {
    var out = {};
    rows.forEach(function (a) {
      var best = [];
      rows.forEach(function (b) {
        if (a === b || a.v.indexOf(b.v) >= 0 || b.v.indexOf(a.v) >= 0) return;
        var n = 0, k;
        for (k in a.seen) if (b.seen[k]) n++;
        if (n >= 2) best.push({ v: b.v, n: n });
      });
      best.sort(function (x, y) { return y.n - x.n; });
      out[a.v] = best.slice(0, 3);
    });
    return out;
  }
  /* v1.48.2/.49.0 — the entity CASSETTE body (pure): name+kind · stats incl. busiest · the labeled
     month chart · top conversations. Since v1.49.0 it renders INLINE per row (Eugen's pick);
     opts.link makes the name a search link, opts.coHtml appends the appears-with line. titleOf is
     injected so tests need no state. */
  function entPopHtml(r, kindLabel, axis, titleOf, opts) {
    opts = opts || {};
    var max = 0, peak = '';
    axis.forEach(function (k) { var n = r.months[k] || 0; if (n > max) { max = n; peak = k; } });
    var bars = axis.map(function (k) {
      var n = r.months[k] || 0;
      return n ? '<i style="height:' + Math.max(4, Math.round(n / (max || 1) * 100)) + '%" title="' + k + ' · ' + n + '"></i>'
        : '<i class="z"></i>';
    }).join('');
    var convs = Object.keys(r.seen).map(function (u) { return { u: u, n: r.seen[u] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 3);
    var name = opts.link ? '<a href="#" class="entq" data-q="' + esc(r.v) + '" title="Search every context">' + esc(r.v) + '</a>' : esc(r.v);
    var h = ['<h4>' + name + '<span class="ep-kind">' + esc(kindLabel) + '</span></h4>',
      '<p class="ep-meta">' + r.chats + ' chats · ' + r.times.toLocaleString() + ' mentions · ' + r.first + ' → ' + r.last +
      (peak ? ' · busiest: ' + peak + ' (' + max.toLocaleString() + '×)' : '') + '</p>',
      '<div class="ep-bars">' + bars + '</div>',
      '<div class="ep-lab"><span>' + (axis[0] || '') + '</span><span>' + (axis[Math.floor(axis.length / 2)] || '') + '</span><span>' + (axis[axis.length - 1] || '') + '</span></div>'];
    var items = [];
    convs.forEach(function (c) {
      var t = titleOf ? titleOf(c.u) : '';
      if (t) items.push('<li><a href="#" class="ep-open" data-u="' + esc(c.u) + '">' + esc(String(t).slice(0, 48)) + '</a> · ' + c.n + '×</li>');
    });
    if (items.length) h.push('<p class="ep-meta" style="margin-bottom:.15rem">most mentions in:</p><ul class="ep-convs">' + items.join('') + '</ul>');
    if (opts.coHtml) h.push('<p class="entco">appears with: ' + opts.coHtml + '</p>');
    return h.join('');
  }

  function heatmapHtml(days) {
    var keys = Object.keys(days).sort();
    if (!keys.length) return '';
    var end = new Date(keys[keys.length - 1] + 'T00:00');
    var start = new Date(keys[0] + 'T00:00');
    if ((end - start) / 86400000 > 370) { start = new Date(end); start.setDate(start.getDate() - 370); }
    var cells = [], i;
    for (i = 0; i < (start.getDay() + 6) % 7; i++) cells.push('<i style="visibility:hidden"></i>');
    var d = new Date(start);
    while (d <= end) { /* Date stepping, not ms += 24h \u2014 DST-safe */
      var k = dayKey(d), n = days[k] || 0;
      var l = !n ? 0 : n < 4 ? 1 : n < 10 ? 2 : n < 25 ? 3 : 4;
      cells.push('<i class="l' + l + '" title="' + k + ' \u00B7 ' + n + ' messages"></i>');
      d.setDate(d.getDate() + 1);
    }
    return '<div class="hm">' + cells.join('') + '</div>' +
      '<p class="hleg">' + dayKey(start) + ' \u2192 ' + dayKey(end) + ' \u00B7 darker = more messages (columns are weeks, Mon\u2013Sun)</p>';
  }

  function streakInfo(days) {
    var keys = Object.keys(days).sort();
    var longest = 0, run = 0, prev = null, i;
    for (i = 0; i < keys.length; i++) {
      var ms = Date.parse(keys[i] + 'T00:00');
      run = (prev !== null && ms - prev < 1.5 * 86400000) ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = ms;
    }
    var cur = 0, d = new Date(); d.setHours(0, 0, 0, 0);
    if (!days[dayKey(d)]) d.setDate(d.getDate() - 1); /* today not over yet \u2014 allow yesterday anchor */
    while (days[dayKey(d)]) { cur++; d.setDate(d.getDate() - 1); }
    return { longest: longest, cur: cur };
  }

  /* period (optional, v1.30.1): a {after,before} window from the query router. "open full Stats" on
     a period answer ("how many hours yesterday") passes it so Stats filters to those same messages
     and matches the strip \u2014 otherwise Stats counts ALL messages of the matched conversations (which
     can span other days) and contradicts the headline. From the top bar there's no period. */
  function openStats(period) {
    if (!state.convs.size) { toast('Import your archive first \u2014 stats are computed from it, locally.'); return; }
    /* v1.26.0: Stats follow the ACTIVE scope (pressed source chips / query filter), like the
       dossier and me.skill — Eugen: "stats mixing all sources but mentions only claude" */
    var scope = viewScope();
    var slist = scope ? scope.list : Array.from(state.convs.values());
    var GAP = 30 * 60000, TAIL = 5;
    var POLITE_RE = /\b(please|pls|thanks|thank you|thx|merci|mersi|mul(?:t|ț)umesc|te rog)\b/i;
    var months = {}, days = {}, hours = [], folders = {}, srcMsgs = {}, evAll = [], evSrc = {};
    var you = { msgs: 0, words: 0 }, cl = { msgs: 0, words: 0 };
    var untimed = 0, i;
    var qMsgs = 0, polite = 0, nightYou = 0, timedYou = 0;
    var maxYou = { w: 0, c: null, j: 0 };
    var attTotal = 0, biggestAtt = { len: 0, c: null, j: 0, fn: '' };
    for (i = 0; i < 24; i++) hours[i] = 0;
    var convList = [], spanList = [], attList = [];
    slist.forEach(function (c) {
      var src = c.source || 'claude', daysOf = {};
      for (var j = 0; j < c.docs.length; j++) {
        var d = c.docs[j], ds = d.d || '';
        var day = ds.slice(0, 10), mon = ds.slice(0, 7);
        if (!day) continue;
        if (period && (day < period.after || day > period.before)) continue; /* router period answer: match the strip's window */
        if (!months[mon]) months[mon] = { msgs: 0, mins: 0, wy: 0, wc: 0, att: 0 };
        if (d.ty !== 'a') {
          daysOf[day] = 1; /* audit S1: "revisited on N days" counts MESSAGE days — a recovered
                              file's mtime (B1) must not add phantom revisit days */
          days[day] = (days[day] || 0) + 1;
          months[mon].msgs++;
          srcMsgs[src] = (srcMsgs[src] || 0) + 1;
          var w = wordCount(d.t);
          if (d.s === 'h') {
            you.msgs++; you.words += w; months[mon].wy += w;
            if (d.t.indexOf('?') >= 0) qMsgs++;
            if (POLITE_RE.test(d.t)) polite++;
            if (w > maxYou.w) { maxYou.w = w; maxYou.c = c; maxYou.j = j; }
          } else { cl.msgs++; cl.words += w; months[mon].wc += w; }
        } else {
          attTotal++; months[mon].att++;
          if (d.t.length > biggestAtt.len) { biggestAtt.len = d.t.length; biggestAtt.c = c; biggestAtt.j = j; biggestAtt.fn = d.fn || '(pasted text)'; }
        }
        if (ds.length > 10) {
          /* audit S1: session time = MESSAGE activity only. Attachment docs carry times that are
             not typing moments (B1 disk files ride their mtime) — measured 2026-07-07: today the
             leak costs ~6 min / 0 sessions, but stray mtimes could invent whole phantom sessions. */
          var ms = d.ty !== 'a' ? Date.parse(ds) : 0;
          if (ms) {
            evAll.push(ms);
            (evSrc[src] = evSrc[src] || []).push(ms);
            if (d.s === 'h') {
              var hr = parseInt(ds.slice(11, 13), 10) || 0;
              hours[hr]++; timedYou++;
              if (hr < 6) nightYou++;
            }
          }
        } else if (d.ty !== 'a') untimed++;
      }
      if (c.source && c.project) folders[c.project] = (folders[c.project] || 0) + c.docs.length;
      convList.push(c);
      spanList.push({ c: c, n: Object.keys(daysOf).length });
      var ufn = (c.fileNames || []).filter(function (n, ix, arr) { return arr.indexOf(n) === ix; }).length;
      if (ufn) attList.push({ c: c, n: ufn });
    });

    var all = sessionize(evAll, GAP, TAIL);
    all.list.forEach(function (s) {
      var dt = new Date(s[0]);
      var mon = dt.getFullYear() + '-' + pad2n(dt.getMonth() + 1);
      if (!months[mon]) months[mon] = { msgs: 0, mins: 0 };
      months[mon].mins += (s[1] - s[0]) / 60000 + TAIL;
    });

    var html = [];
    /* totals */
    html.push('<h3>Totals</h3><div class="stt">' +
      '<span>time (est.)<b>' + fmtDur(all.mins) + '</b></span>' +
      '<span>sessions<b>' + all.n.toLocaleString() + '</b></span>' +
      (all.n ? '<span>avg session<b>' + fmtDur(all.mins / all.n) + '</b></span>' : '') +
      '<span>you typed<b>' + you.words.toLocaleString() + ' words</b></span>' +
      '<span>the assistant wrote<b>' + cl.words.toLocaleString() + ' words</b></span></div>');
    if (untimed) html.push('<p class="note">\u26A0 ' + untimed.toLocaleString() +
      ' messages have no time-of-day yet \u2014 re-import once (drop your export zip / re-drag session folders) to count them in time stats.</p>');

    /* months */
    var monKeys = Object.keys(months).sort();
    var maxMsgs = 1;
    monKeys.forEach(function (k) { if (months[k].msgs > maxMsgs) maxMsgs = months[k].msgs; });
    /* v1.45.9 — the month graph opens showing the LATEST months (Eugen: the first screen showed the
       near-zero early-AI years). Chronological order kept; the list lives in a capped scroll box that
       starts scrolled to the bottom (see the scrollTop after openPage) — scroll UP to the beginning. */
    html.push('<h3>By month</h3>');
    html.push('<div class="monwrap" id="monwrap">');
    monKeys.forEach(function (k) {
      var m = months[k];
      html.push(srow(k, m.msgs / maxMsgs, m.msgs.toLocaleString() + ' msg' +
        (m.mins ? '<i>' + fmtDur(m.mins) + '</i>' : '') +
        '<i>' + fmtK(m.wy) + ' / ' + fmtK(m.wc) + ' words</i>'));
    });
    html.push('</div>');
    if (monKeys.length > 14) html.push('<p class="hleg">latest months shown — scroll up inside the graph for the beginning</p>');

    /* heatmap + streaks */
    var st = streakInfo(days);
    html.push('<h3>Active days</h3>' + heatmapHtml(days) +
      '<div class="stt"><span>active days<b>' + Object.keys(days).length + '</b></span>' +
      '<span>longest streak<b>' + st.longest + (st.longest === 1 ? ' day' : ' days') + '</b></span>' +
      '<span>current streak<b>' + st.cur + (st.cur === 1 ? ' day' : ' days') + '</b></span></div>');

    /* hour of day */
    var maxH = 1;
    for (i = 0; i < 24; i++) if (hours[i] > maxH) maxH = hours[i];
    if (evAll.length) {
      html.push('<h3>Your messages by hour</h3><div class="hbars">' +
        hours.map(function (n, h) {
          return '<i style="height:' + Math.max(2, Math.round(n / maxH * 100)) + '%" title="' + h + ':00 \u00B7 ' + n + '"></i>';
        }).join('') + '</div>' +
        '<div class="hlab"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>');
    }

    /* weekday rhythm \u2014 skip weekdays with zero messages (a row of "0 msg" bars is noise, e.g. a
       single-day router answer where only one weekday has data), and drop the whole section unless
       at least two weekdays are present \u2014 a weekday comparison needs more than one day to mean
       anything. Full-archive view is unchanged (all seven have data). */
    var wd = [0, 0, 0, 0, 0, 0, 0], wdNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], maxW = 1, nzWd = 0;
    Object.keys(days).forEach(function (k) { wd[(new Date(k + 'T00:00').getDay() + 6) % 7] += days[k]; });
    for (i = 0; i < 7; i++) { if (wd[i] > maxW) maxW = wd[i]; if (wd[i]) nzWd++; }
    if (nzWd >= 2) {
      html.push('<h3>By weekday</h3>');
      for (i = 0; i < 7; i++) if (wd[i]) html.push(srow(wdNames[i], wd[i] / maxW, wd[i].toLocaleString() + ' msg'));
    }

    /* you vs claude */
    var maxYC = Math.max(you.msgs, cl.msgs) || 1;
    html.push('<h3>You vs the assistant</h3>' +
      srow('you', you.msgs / maxYC, you.msgs.toLocaleString() + ' msg<i>avg ' + Math.round(you.words / (you.msgs || 1)) + ' words</i>') +
      srow('assistant', cl.msgs / maxYC, cl.msgs.toLocaleString() + ' msg<i>avg ' + Math.round(cl.words / (cl.msgs || 1)) + ' words</i>', true));

    /* fun counters — your messages only */
    html.push('<h3>Fun counters</h3><div class="stt">' +
      '<span>questions you asked<b>' + qMsgs.toLocaleString() + '</b></span>' +
      '<span>polite messages<b>' + polite.toLocaleString() + (you.msgs ? ' (' + Math.round(polite / you.msgs * 100) + '%)' : '') + '</b></span>' +
      (timedYou ? '<span>night owl (00–06)<b>' + Math.round(nightYou / timedYou * 100) + '%</b></span>' : '') +
      '</div>');

    /* sources + folders */
    var srcKeys = Object.keys(srcMsgs);
    if (srcKeys.length > 1) {
      html.push('<h3>By source</h3>');
      var maxS = 1;
      srcKeys.forEach(function (k) { if (srcMsgs[k] > maxS) maxS = srcMsgs[k]; });
      srcKeys.sort(function (a, b) { return srcMsgs[b] - srcMsgs[a]; }).forEach(function (k) {
        var t = evSrc[k] ? sessionize(evSrc[k], GAP, TAIL) : { mins: 0 };
        html.push(srow(k, srcMsgs[k] / maxS, srcMsgs[k].toLocaleString() + ' msg' + (t.mins ? '<i>' + fmtDur(t.mins) + '</i>' : '')));
      });
    }
    var folKeys = Object.keys(folders).sort(function (a, b) { return folders[b] - folders[a]; }).slice(0, 8);
    if (folKeys.length) {
      html.push('<h3>Top folders (sessions)</h3>');
      var maxF = folders[folKeys[0]] || 1;
      folKeys.forEach(function (k) { html.push(srow(k, folders[k] / maxF, folders[k].toLocaleString() + ' msg')); });
    }

    /* files */
    if (attTotal || attList.length) {
      attList.sort(function (a, b) { return b.n - a.n; });
      html.push('<h3>Files</h3><div class="stt">' +
        '<span>text attachments<b>' + attTotal.toLocaleString() + '</b></span>' +
        (biggestAtt.c ? '<span>biggest<b><a class="readlink" href="#" data-conv="' + esc(biggestAtt.c.uuid) + '" data-doc="' + biggestAtt.j + '">' + esc(biggestAtt.fn) + '</a> (' + Math.round(biggestAtt.len / 1024) + ' KB)</b></span>' : '') +
        '</div>');
      if (attList.length) {
        html.push('<ul>');
        attList.slice(0, 3).forEach(function (a) {
          html.push('<li><a class="readlink" href="#" data-conv="' + esc(a.c.uuid) + '" data-doc="0">' + esc(a.c.name) + '</a> \u2014 ' + a.n + ' files</li>');
        });
        html.push('</ul>');
      }
    }

    /* records */
    var busyDay = '', busyN = 0;
    Object.keys(days).forEach(function (k) { if (days[k] > busyN) { busyN = days[k]; busyDay = k; } });
    var longSes = null;
    all.list.forEach(function (s) { if (!longSes || s[1] - s[0] > longSes[1] - longSes[0]) longSes = s; });
    convList.sort(function (a, b) { return b.docs.length - a.docs.length; });
    spanList.sort(function (a, b) { return b.n - a.n; });
    html.push('<h3>Records</h3><ul>');
    if (busyDay) html.push('<li>busiest day: <strong>' + busyDay + '</strong> \u2014 ' + busyN.toLocaleString() + ' messages</li>');
    if (longSes) html.push('<li>longest session: <strong>' + dayKey(new Date(longSes[0])) + '</strong> \u2014 ' + fmtDur((longSes[1] - longSes[0]) / 60000 + TAIL) + ' straight</li>');
    if (maxYou.c) html.push('<li>your longest message: <a class="readlink" href="#" data-conv="' + esc(maxYou.c.uuid) + '" data-doc="' + maxYou.j + '">' + maxYou.w.toLocaleString() + ' words</a> in ' + esc(maxYou.c.name) + '</li>');
    convList.slice(0, 5).forEach(function (c) {
      html.push('<li><a class="readlink" href="#" data-conv="' + esc(c.uuid) + '" data-doc="0">' + esc(c.name) + '</a> \u2014 ' + c.docs.length + ' messages</li>');
    });
    spanList.slice(0, 3).forEach(function (s) {
      if (s.n < 2) return;
      html.push('<li><a class="readlink" href="#" data-conv="' + esc(s.c.uuid) + '" data-doc="0">' + esc(s.c.name) + '</a> \u2014 revisited on ' + s.n + ' different days</li>');
    });
    html.push('</ul>');

    html.push('<p class="note">Method: messages less than 30 min apart count as one session; each session gets +5 min for reading the last reply. It is an estimate \u2014 parallel work across sources overlaps, so per-source times can sum to more than the total. Computed locally; nothing leaves this browser.</p>');
    openPage('Stats', (scope ? scope.label + ' \u2014 ' + slist.length + ' of ' + state.convs.size : state.convs.size) +
      ' conversations \u00B7 computed locally, nothing uploaded', html.join(''));
    var mw = $('#monwrap'); /* v1.45.9 \u2014 open the month graph at its LATEST end */
    if (mw) mw.scrollTop = mw.scrollHeight;
  }

  /* ~tokens proxy — GPT-style ≈ chars/4; text only (binary bytes aren't in the export) */
  function estTok(chars) { return Math.round(chars / 4); }

  /* machine/system lines that survive msAuthored (git hints, Cowork/Code session banners,
     pasted console errors) — filtered from the coach's re-explanations so we never tell the
     user "you typed this" about text they didn't write. Bracket-only [dismissed] markers are
     handled separately. Coach-only: the A/B-validated me.skill extractor stays untouched. */
  var COACH_NOISE = /^(hint: |this session is being continued|unchecked runtime\.lasterror|uncaught (type|reference|syntax|range)error|traceback \(most recent|npm (err|warn)|remote: |fatal: )/i;

  /* Token coach — mines the local archive for token waste and what to move into a skill/CLAUDE.md.
     Reuses the me.skill machinery: adaptive gates, derived accept/reject vocab, prose/rework
     detection. On-demand (menu click); a few passes over the archive, same order as openStats. */
  function openTokenCoach() {
    if (!state.convs.size) { toast('Import your archive first — the coach reads it locally.'); return; }
    var scope = viewScope(); /* v1.26.0: the coach follows the active scope too */
    var slist = scope ? scope.list : Array.from(state.convs.values());
    var G = msGates(scope && scope.list), V = msDeriveVocab(G, scope && scope.list);
    var pvHit = function (u, set) { var ws = msWordsOf(u); for (var i = 0; i < ws.length; i++) if (set[ws[i]]) return true; return false; };
    var pvPos = function (u) { return PV_POS.test(u) || pvHit(u, V.accept); };
    var pvNeg = function (u) { return PV_NEG.test(u) || pvHit(u, V.reject); };

    var months = {}, youC = 0, clC = 0, attC = 0, recC = 0;
    var repChats = {}, repEx = {};                 /* re-explanations: normalized msg -> chats/example */
    var fnChats = {}, attByFn = {};                /* re-uploaded files: name -> distinct chats (+ token size for reclaim) */
    var spirals = [];                              /* rework loops per conv */

    slist.forEach(function (c) {
      var src = c.source || 'claude';
      var turns = [], hFns = {}, aFns = {};
      for (var j = 0; j < c.docs.length; j++) {
        var d = c.docs[j], mon = (d.d || '').slice(0, 7);
        var m = mon ? (months[mon] = months[mon] || { i: 0, o: 0 }) : null;
        if (d.ty === 'a') {
          var afn = d.fn || '(pasted text)';
          /* coach audit C1 (2026-07-07): spend must count what the USER provided. s:'h'
             attachments = pasted text / uploads / files read into context. s:'a' attachments
             are Claude's OWN work products recovered from session folders/transcripts (B1/B2)
             — counting them as "you sent" overstated spend by ~31% and re-broke the v1.16.0
             reclaim bound. They get their own counter, outside chat spend. */
          if (d.s === 'a') { recC += d.t.length; aFns[afn] = 1; }
          else {
            attC += d.t.length; if (m) m.i += d.t.length;
            hFns[afn] = 1;
            if (src !== 'project') { /* project knowledge is already IN a project — advice would be circular */
              var ab = attByFn[afn] = attByFn[afn] || { chats: {}, sum: 0 };
              ab.chats[c.uuid] = 1; ab.sum += estTok(d.t.length); /* actual tokens, summed over instances */
            }
          }
        }
        else {
          turns.push(d);
          if (d.s === 'h') {
            youC += d.t.length; if (m) m.i += d.t.length;
            var prose = msAuthored(d);
            if (prose && prose.length >= 40) { /* skip trivial acks/openers; those are cheap */
              var red = msRedact(prose);
              /* drop machine/system text that isn't the user's voice (see COACH_NOISE) */
              if (!COACH_NOISE.test(red) && !/^\[[^\]]*\]$/.test(red.trim())) {
                var k = msNorm(red);
                (repChats[k] = repChats[k] || {})[c.uuid] = 1;
                if (!repEx[k]) repEx[k] = { uuid: c.uuid, j: j, text: red };
              }
            }
          } else { clC += d.t.length; if (m) m.o += d.t.length; }
        }
      }
      var seenFn = {};
      (c.fileNames || []).forEach(function (fn) {
        if (seenFn[fn]) return; seenFn[fn] = 1; /* dedupe within a conv first */
        /* coach audit C3: the "re-uploaded files" panel advises what YOU should stop re-sending —
           placeholder pastes, Claude-produced session files (s:'a' only) and project knowledge
           don't belong in that advice */
        if (fn === '(pasted text)' || src === 'project') return;
        if (aFns[fn] && !hFns[fn]) return;
        (fnChats[fn] = fnChats[fn] || {})[c.uuid] = 1;
      });
      /* rework loop: assistant -> short FAST negative reaction -> assistant REDID it (same reject
         signature msDeriveVocab uses). Count per conv; 2+ loops = a spiral worth surfacing. */
      var loops = 0;
      for (var i = 0; i + 2 < turns.length; i++) {
        if (turns[i].s !== 'a' || turns[i + 1].s !== 'h' || turns[i + 2].s !== 'a') continue;
        var u = msProse(turns[i + 1].t);
        if (!u || u.split(/\s+/).length > G.critWords || !pvNeg(u) || pvPos(u)) continue;
        var gap = pvMins(turns[i].d, turns[i + 1].d);
        if (gap !== null && gap > 10) continue;
        if (msSimAB(turns[i].t, turns[i + 2].t) < 0.5) continue; /* assistant didn't redo = not rework */
        loops++;
      }
      if (loops >= 2) spirals.push({ c: c, loops: loops });
    });

    /* reclaimable-token math for "What you'd gain" — kept HONEST so reclaim can NEVER exceed what
       was actually sent: recover all-but-one instance of a repeated file, and skip the
       "(pasted text)" placeholder (77 DISTINCT pastes, not one re-uploadable file — counting it
       inflated reclaim past total spend). */
    var reExplainReclaim = 0;
    Object.keys(repChats).forEach(function (k) {
      var n = Object.keys(repChats[k]).length;
      if (n >= 3) reExplainReclaim += estTok(repEx[k].text.length) * (n - 1);
    });
    var fileReclaim = 0;
    Object.keys(attByFn).forEach(function (fn) {
      var a = attByFn[fn], n = Object.keys(a.chats).length;
      if (n >= 2 && fn !== '(pasted text)') fileReclaim += Math.round(a.sum * (n - 1) / n);
    });
    var totalLoops = 0; spirals.forEach(function (s) { totalLoops += s.loops; });
    var reclaim = reExplainReclaim + fileReclaim;

    var html = [];
    html.push('<p class="note">Where your tokens go, what you get back by acting on it, and exactly how. Each section ends with a <strong>How:</strong> step.</p>');
    /* headline spend */
    html.push('<h3>Token spend (rough estimate)</h3><div class="stt">' +
      '<span>you sent — typed<b>~' + fmtK(estTok(youC)) + '</b></span>' +
      '<span>you sent — pasted files<b>~' + fmtK(estTok(attC)) + '</b></span>' +
      '<span>the assistant wrote<b>~' + fmtK(estTok(clC)) + '</b></span>' +
      '<span>total<b>~' + fmtK(estTok(youC + attC + clC)) + '</b></span></div>' +
      (recC ? '<p class="note">Not counted above: ~' + fmtK(estTok(recC)) +
        ' tokens of files Claude produced in your sessions (recovered from session folders/transcripts) — stored in the archive, but not something you sent.</p>' : ''));

    /* what you'd gain — the payoff of acting (Eugen: show the actual gain, not just the mechanics) */
    if (reclaim > 0 || totalLoops > 0) {
      html.push('<h3>What you’d gain</h3><div class="stt">' +
        '<span>context you’d stop re-sending<b>~' + fmtK(reclaim) + ' tok</b></span>' +
        '<span>rework rounds in flagged chats<b>' + totalLoops + '</b></span></div>' +
        '<p class="note"><strong>Token economy → longer sessions:</strong> the ~' + fmtK(reclaim) +
        ' tokens of repeated context you stop re-sending free up room in every new chat — you hit the limit later and Claude keeps more of the real work in view. ' +
        '<strong>Faster starts:</strong> a skill or <code>CLAUDE.md</code> loads your rules and files automatically, so you skip the setup paragraph. ' +
        '<strong>Better first answers:</strong> front-loading the goal and constraints turns many of those ' + totalLoops + ' rework rounds into one-shots.</p>');
    }
    /* by-month bars (in = your typed + pasted context, out = Claude) */
    var monKeys = Object.keys(months).sort(), maxT = 1;
    monKeys.forEach(function (k) { var t = months[k].i + months[k].o; if (t > maxT) maxT = t; });
    if (monKeys.length) {
      html.push('<h3>By month (~tokens)</h3>');
      monKeys.forEach(function (k) {
        var mm = months[k], t = mm.i + mm.o;
        html.push(srow(k, t / maxT, '~' + fmtK(estTok(t)) + '<i>' + fmtK(estTok(mm.i)) + ' in / ' + fmtK(estTok(mm.o)) + ' out</i>'));
      });
    }

    /* re-explanations -> skills (keystone) */
    var reps = Object.keys(repChats).map(function (k) {
      return { chats: Object.keys(repChats[k]).length, ex: repEx[k] };
    }).filter(function (r) { return r.chats >= 3; })
      .sort(function (a, b) { return (b.chats * b.ex.text.length) - (a.chats * a.ex.text.length); })
      .slice(0, 8);
    if (reps.length) {
      html.push('<h3>Re-explanations → move into a skill</h3>' +
        '<p class="note">You typed these near-identical messages across many chats — turn each into a reusable instruction so you never retype it. <strong>How:</strong> drop the text in a <code>CLAUDE.md</code> at your project root (Claude Code / Cowork read it every session), or make a skill on claude.ai → Settings → Capabilities. Click a line to open where you wrote it and copy the wording.</p><ul>');
      reps.forEach(function (r) {
        var snip = r.ex.text.length > 130 ? r.ex.text.slice(0, 130) + '…' : r.ex.text;
        html.push('<li><a class="readlink" href="#" data-conv="' + esc(r.ex.uuid) + '" data-doc="' + r.ex.j + '">' + esc(snip) + '</a><br>' +
          '<span class="note">in <strong>' + r.chats + ' chats</strong> · ~' + fmtK(estTok(r.ex.text.length) * (r.chats - 1)) + ' tokens saved by a one-time skill</span></li>');
      });
      html.push('</ul>');
    }

    /* re-uploaded files -> project knowledge */
    var files = Object.keys(fnChats).map(function (fn) { return { fn: fn, chats: Object.keys(fnChats[fn]).length }; })
      .filter(function (f) { return f.chats >= 2; })
      .sort(function (a, b) { return b.chats - a.chats; }).slice(0, 8);
    if (files.length) {
      html.push('<h3>Re-uploaded files → project knowledge</h3>' +
        '<p class="note">The same file rode along in several chats — add it once so every chat can see it. <strong>How:</strong> on claude.ai, open or create a Project → <em>Add content</em> → upload the file, then start those chats inside the Project instead of re-attaching. In Claude Code / Cowork, keep it in the repo and just mention its path.</p><ul>');
      files.forEach(function (f) { html.push('<li><strong>' + esc(f.fn) + '</strong> — in ' + f.chats + ' chats</li>'); });
      html.push('</ul>');
    }

    /* rework spirals */
    if (spirals.length) {
      spirals.sort(function (a, b) { return b.loops - a.loops; });
      html.push('<h3>Rework spirals</h3>' +
        '<p class="note">Chats where Claude redid its answer several times — usually the first prompt was under-specified. <strong>How:</strong> lead with the goal, the hard constraints, and one example before asking; park constraints you repeat in a <code>CLAUDE.md</code> or skill so you state them once. Open one to see what kept looping. Heuristic — skim before trusting.</p><ul>');
      spirals.slice(0, 8).forEach(function (s) {
        html.push('<li><a class="readlink" href="#" data-conv="' + esc(s.c.uuid) + '" data-doc="0">' + esc(s.c.name) + '</a> — ' + s.loops + ' rework loops</li>');
      });
      html.push('</ul>');
    }

    if (reps.length + files.length + spirals.length === 0) {
      html.push('<p class="note">No strong waste patterns yet — a lean archive, or not enough repetition to flag.</p>');
    }
    html.push('<p class="note">Estimates are ~chars÷4 (a rough token proxy; text only — binary file bytes aren’t in the export). Computed locally; nothing leaves this browser.</p>');
    openPage('Token coach', (scope ? scope.label + ' — ' + slist.length + ' of ' + state.convs.size : state.convs.size) +
      ' conversations · computed locally, nothing uploaded', html.join(''));
  }

  /* v1.45.3 — the footer links, repeated at the END of every static page: with a loaded archive the
     real footer sits below hundreds of browse rows (Eugen: "many scrolls away"). Current page shown
     unlinked; feedback stays a plain mailto. */
  function pageLinksHtml(cur) {
    var L = [['about', 'about'], ['faq', 'faq'], ['privacy', 'privacy'], ['help', 'how to use']];
    var out = L.map(function (p) {
      return p[0] === cur ? '<span>' + p[1] + '</span>' : '<a href="#" data-pg="' + p[0] + '">' + p[1] + '</a>';
    });
    out.push('<a href="mailto:hello@colloquary.com">feedback</a>');
    out.push('<a href="' + SRC_URL + '" target="_blank" rel="noopener">source</a>');
    out.push('<span>v' + APP_VERSION + '</span>');
    return '<p class="pglinks">' + out.join(' · ') + '</p>';
  }
  function wirePageLinks() {
    var fns = { about: openAbout, faq: openFaq, privacy: openPrivacy, help: openHelp };
    var as = $('#reader-body').querySelectorAll('a[data-pg]');
    for (var i = 0; i < as.length; i++) (function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); fns[a.getAttribute('data-pg')](); });
    })(as[i]);
  }

  function openHelp() {
    var h = [];
    h.push('<p>colloquary is a private, offline viewer for your Claude and ChatGPT data export — read the exported <code>.zip</code> / <code>conversations.json</code> you can’t easily open, search old chats, find a lost conversation, ask questions about your history, track your token usage, and turn your chats into reusable skills. Everything runs locally in this browser; nothing is uploaded. New here? Click <strong>Try a sample archive</strong> on the empty state to explore with clearly-fake data first. Looking for search recipes? The <a href="#" id="help-faq">FAQ</a> answers by example.</p>');
    /* v1.45.0 — the map: how the top-bar pieces connect (inline SVG, app palette, ~2 KB, local).
       v1.45.3 — phones get a purpose-built 360-wide variant (rewrapped lines) chosen at render time:
       the 640 viewBox scaled to ~60% on a phone → ~7px type (Eugen: "schema quite small on mobile").
       Desktop string below is byte-identical to v1.45.0. */
    var hmMob = window.matchMedia && matchMedia('(max-width:640px)').matches;
    if (hmMob) h.push('<h3>The map</h3>' +
      '<svg viewBox="0 0 360 656" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How the parts of colloquary connect" style="width:100%;max-width:420px;display:block;margin:.4rem 0 .8rem">' +
      '<defs><marker id="hm-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--muted)"/></marker></defs>' +
      '<style>.hm-b{fill:var(--card);stroke:var(--hair)}.hm-t{font:600 12.5px var(--mono);fill:var(--ledger)}.hm-s{font:10.5px var(--mono);fill:var(--ink)}.hm-m{font:10.5px var(--mono);fill:var(--muted)}.hm-l{stroke:var(--muted);stroke-width:1;marker-end:url(#hm-a)}</style>' +
      '<rect class="hm-b" x="8" y="6" width="344" height="96" rx="2"/>' +
      '<text class="hm-t" x="20" y="28">1 · import</text>' +
      '<text class="hm-s" x="20" y="44">drop your Claude / ChatGPT export .zip —</text>' +
      '<text class="hm-s" x="20" y="60">or drag a Code / Cowork session folder</text>' +
      '<text class="hm-m" x="20" y="76">re-drop a fresh export anytime:</text>' +
      '<text class="hm-m" x="20" y="92">only new chats import</text>' +
      '<line class="hm-l" x1="180" y1="102" x2="180" y2="122"/>' +
      '<rect class="hm-b" x="8" y="124" width="344" height="96" rx="2"/>' +
      '<text class="hm-t" x="20" y="146">2 · your archive — in THIS browser</text>' +
      '<text class="hm-s" x="20" y="162">IndexedDB on this device · nothing uploaded</text>' +
      '<text class="hm-s" x="20" y="178">works offline</text>' +
      '<text class="hm-m" x="20" y="194">backup / move: Download archive → one .zip</text>' +
      '<text class="hm-m" x="20" y="210">→ drop it on another device (phone included)</text>' +
      '<line class="hm-l" x1="180" y1="220" x2="180" y2="240"/>' +
      '<rect class="hm-b" x="8" y="242" width="344" height="112" rx="2"/>' +
      '<text class="hm-t" x="20" y="264">3 · explore</text>' +
      '<text class="hm-s" x="20" y="280">search (any language) + operators</text>' +
      '<text class="hm-s" x="20" y="296">ask a question · Stats · Token coach · Entities</text>' +
      '<text class="hm-s" x="20" y="312">reader: Find · files · Summarize · Save PDF</text>' +
      '<text class="hm-s" x="20" y="328">📌 pins · ⬇ dossier</text>' +
      '<text class="hm-m" x="20" y="344">Make me.skill works here — no AI model needed</text>' +
      '<line class="hm-l" x1="180" y1="354" x2="180" y2="374"/>' +
      '<text class="hm-m" x="192" y="370">unlocks</text>' +
      '<rect class="hm-b" x="8" y="376" width="344" height="96" rx="2"/>' +
      '<text class="hm-t" x="20" y="398">4 · semantic — opt-in</text>' +
      '<text class="hm-s" x="20" y="414">one local model download → your archive</text>' +
      '<text class="hm-s" x="20" y="430">embedded as vectors, on-device</text>' +
      '<text class="hm-m" x="20" y="446">≈ hybrid search · model: e5 or Gemma</text>' +
      '<text class="hm-m" x="20" y="462">embeddings → one .cvec file → phone</text>' +
      '<line class="hm-l" x1="180" y1="472" x2="180" y2="492"/>' +
      '<rect class="hm-b" x="8" y="494" width="344" height="96" rx="2"/>' +
      '<text class="hm-t" x="20" y="516">5 · compile</text>' +
      '<text class="hm-s" x="20" y="532">Compile a topic · Compile a skill</text>' +
      '<text class="hm-s" x="20" y="548">(presets · phrases · a + b) · Suggest skills</text>' +
      '<text class="hm-m" x="20" y="564">honest by construction: thin topics</text>' +
      '<text class="hm-m" x="20" y="580">abort instead of padding</text>' +
      '<line class="hm-l" x1="180" y1="590" x2="180" y2="610"/>' +
      '<text class="hm-t" x="20" y="632">→ install the <tspan fill="#ff5c39">.skill</tspan> in Claude —</text>' +
      '<text class="hm-t" x="20" y="650">every session then knows how you work</text>' +
      '</svg>');
    else h.push('<h3>The map</h3>' +
      '<svg viewBox="0 0 640 468" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How the parts of colloquary connect" style="width:100%;max-width:640px;display:block;margin:.4rem 0 .8rem">' +
      '<defs><marker id="hm-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--muted)"/></marker></defs>' +
      '<style>.hm-b{fill:var(--card);stroke:var(--hair)}.hm-t{font:600 12.5px var(--mono);fill:var(--ledger)}.hm-s{font:10.5px var(--mono);fill:var(--ink)}.hm-m{font:10.5px var(--mono);fill:var(--muted)}.hm-l{stroke:var(--muted);stroke-width:1;marker-end:url(#hm-a)}</style>' +
      '<rect class="hm-b" x="20" y="6" width="600" height="60" rx="2"/>' +
      '<text class="hm-t" x="36" y="28">1 · import</text>' +
      '<text class="hm-s" x="36" y="45">drop your Claude / ChatGPT export .zip — or drag a Code / Cowork session folder</text>' +
      '<text class="hm-m" x="36" y="59">re-drop a fresh export anytime: only new chats import</text>' +
      '<line class="hm-l" x1="320" y1="66" x2="320" y2="86"/>' +
      '<rect class="hm-b" x="20" y="88" width="600" height="60" rx="2"/>' +
      '<text class="hm-t" x="36" y="110">2 · your archive — in THIS browser</text>' +
      '<text class="hm-s" x="36" y="127">IndexedDB on this device · nothing uploaded · works offline</text>' +
      '<text class="hm-m" x="36" y="141">backup / move: Download archive → one .zip → drop it on another device (phone included)</text>' +
      '<line class="hm-l" x1="320" y1="148" x2="320" y2="168"/>' +
      '<rect class="hm-b" x="20" y="170" width="600" height="74" rx="2"/>' +
      '<text class="hm-t" x="36" y="192">3 · explore</text>' +
      '<text class="hm-s" x="36" y="209">search (any language) + operators · ask a question · Stats · Token coach · Entities</text>' +
      '<text class="hm-s" x="36" y="223">reader: Find · files · Summarize · Save PDF · 📌 pins · ⬇ dossier</text>' +
      '<text class="hm-m" x="36" y="237">Make me.skill works from here — no AI model needed</text>' +
      '<line class="hm-l" x1="320" y1="244" x2="320" y2="264"/>' +
      '<rect class="hm-b" x="20" y="266" width="600" height="60" rx="2"/>' +
      '<text class="hm-t" x="36" y="288">4 · semantic — opt-in</text>' +
      '<text class="hm-s" x="36" y="305">one local model download → your archive embedded as vectors, on-device</text>' +
      '<text class="hm-m" x="36" y="319">≈ hybrid search · model: e5 or Gemma · embeddings → one .cvec file → phone</text>' +
      '<line class="hm-l" x1="320" y1="326" x2="320" y2="346"/>' +
      '<text class="hm-m" x="332" y="342">unlocks</text>' +
      '<rect class="hm-b" x="20" y="348" width="600" height="60" rx="2"/>' +
      '<text class="hm-t" x="36" y="370">5 · compile</text>' +
      '<text class="hm-s" x="36" y="387">Compile a topic · Compile a skill (presets · phrases · a + b merges) · Suggest skills</text>' +
      '<text class="hm-m" x="36" y="401">honest by construction: thin topics abort instead of padding</text>' +
      '<line class="hm-l" x1="320" y1="408" x2="320" y2="428"/>' +
      '<text class="hm-t" x="36" y="450">→ install the <tspan fill="#ff5c39">.skill</tspan> in Claude — every session then knows how you work</text>' +
      '</svg>');
    h.push('<h3>Import</h3><ul>' +
      '<li><strong>claude.ai:</strong> Settings \u2192 Privacy \u2192 <strong>Export data</strong>, wait for the email, download the zip, drag it anywhere on this page (no need to unzip). Your <strong>Projects</strong> come along: each project with knowledge docs becomes its own entry (project tab / <code>source:project</code>) with every doc openable and searchable.</li>' +
      '<li><strong>Updates:</strong> request a fresh export later and drop it here \u2014 only new and changed conversations are re-imported, nothing is duplicated or lost.</li>' +
      '<li><strong>Claude Code / Cowork:</strong> drag your <code>~/.claude</code> or <code>local-agent-mode-sessions</code> folder onto the page (or \u22EF \u2192 Import Code/Cowork sessions\u2026). Re-drag the same folder anytime to pick up new sessions. Text files a session produced or received (outputs/uploads \u2014 code, handovers, reports up to 200 KB each) are attached to it: openable, downloadable, searchable. Files recovered from the transcript itself show the file <em>as the session last fully read or wrote it</em> \u2014 later small edits within the session aren\u2019t captured. Re-drag once to add them to sessions imported before this feature.</li>' +
      '<li><strong>ChatGPT:</strong> chatgpt.com \u2192 Settings \u2192 Data controls \u2192 <strong>Export data</strong>, download the zip from OpenAI\u2019s email and drop it here \u2014 threads import exactly as you last saw them (edited/regenerated branches resolved). Same local-only rule: nothing is uploaded.</li></ul>' +
      '<p><strong>Finding the session folders</strong> (they live in hidden system folders):</p><ul>' +
      '<li><strong>macOS \u2014 Cowork:</strong> in Finder press <code>Cmd+Shift+G</code> and paste <code>~/Library/Application Support/Claude/local-agent-mode-sessions</code>. Or in Terminal: <code>open "$HOME/Library/Application Support/Claude/local-agent-mode-sessions"</code>. Then drag the folder from the Finder window\u2019s title bar onto this page.</li>' +
      '<li><strong>macOS \u2014 Claude Code:</strong> same trick with <code>~/.claude</code> (Finder hides dot-folders; <code>Cmd+Shift+G</code> gets you there, or press <code>Cmd+Shift+.</code> in your home folder to reveal them).</li>' +
      '<li><strong>Windows \u2014 Cowork:</strong> in Explorer\u2019s address bar paste <code>%APPDATA%\\Claude\\local-agent-mode-sessions</code> and press Enter (typical location).</li>' +
      '<li><strong>Windows \u2014 Claude Code:</strong> Explorer address bar \u2192 <code>%USERPROFILE%\\.claude</code>.</li></ul>');
    h.push('<h3>Search</h3>' +
      '<p>Plain words must ALL match (AND, like Gmail). Prefix matching from 3 letters, typo-tolerance from 5. Accents are ignored (<code>sapa</code> finds <code>\u0218apa</code>).</p><ul>' +
      '<li><code>"exact phrase"</code> \u2014 must appear verbatim (also matches titles)</li>' +
      '<li><code>-word</code> \u2014 exclude (also scans titles and file names)</li>' +
      '<li><code>from:me</code> / <code>from:claude</code> \u2014 who wrote it</li>' +
      '<li><code>chat:budget</code> \u2014 conversation title contains\u2026 (quotes ok: <code>chat:"quarterly review"</code>)</li>' +
      '<li><code>on:2026-05-03</code> \u00B7 <code>after:2026-05</code> \u00B7 <code>before:2026</code> \u2014 dates; dots/slashes and dd.mm.yyyy accepted</li>' +
      '<li><code>file:report</code> \u2014 has an attachment whose name contains\u2026 \u00B7 <code>has:attachment</code></li>' +
      '<li><strong>What gets searched:</strong> every message PLUS the text of attachments, Project-knowledge docs and files recovered from your sessions — filenames too (<code>file:</code> targets them directly).</li>' +
      '<li><code>source:claude|chatgpt|cowork|code|project</code> \u2014 where it happened. The chips above the results do the same and can be COMBINED \u2014 click to toggle several at once (e.g. cowork + code); <em>all</em> clears. Stats, the Token coach and Make me.skill all follow the selected chips / active filter.</li>' +
      '<li><code>folder:"my-project"</code> \u2014 Cowork/Code sessions by working folder (\uD83D\uDCC1 chips do the same)</li>' +
      '<li><code>OR</code> \u2014 either side may match: <code>invoice OR factur\u0103</code>. Filters alone (no words) list matching conversations.</li>' +
      '<li><strong>Semantic search (opt-in):</strong> the top-bar button downloads an AI model once (~120\u2013240 MB, self-hosted \u2014 no third parties) and embeds your archive locally. Afterwards the <code>\u2248 semantic</code> toggle by the search bar folds meaning-based matches into results \u2014 paraphrases, other languages, vague memories; snippets found this way are marked <code>\u2248</code>. All operators and chips still apply; toggle off = classic keyword search, untouched. New imports embed incrementally.</li>' +
      '<li><strong>⬇ dossier:</strong> with a search or filter active, export the matching conversations as ONE chronological markdown file — readable, or attach it to a fresh AI chat as context.</li></ul>');
    h.push('<h3>Ask questions</h3>' +
      '<p>Type a <em>question</em> instead of keywords and colloquary computes the answer from your archive, shown in a strip above the results (the matching conversations still list below). All local. The <span style="color:var(--ledger)">ask a question</span> chips under the search bar are one-click examples. The question grammar currently understands <strong>English and Romanian</strong> — ask in another language and nothing breaks: it simply runs as a normal search (which works in ANY language), just without the computed strip.</p><ul>' +
      '<li><strong>How many</strong> \u2014 <code>how many invoices chats?</code> \u00b7 <code>how many messages about taxes</code> \u00b7 <code>c\u00e2te conversa\u021bii despre\u2026</code></li>' +
      '<li><strong>How long</strong> \u2014 <code>how many hours on the redesign?</code> \u00b7 <code>c\u00e2te ore la\u2026?</code></li>' +
      '<li><strong>When</strong> \u2014 <code>when did I first talk about Docker?</code> \u00b7 <code>c\u00e2nd am \u00eenceput\u2026</code></li>' +
      '<li><strong>Activity</strong> \u2014 <code>how active was I last month?</code> \u00b7 <code>how many chats in June</code> \u00b7 <code>\u2026 this week / last year / 2025</code></li>' +
      '<li>The answer covers the SAME conversations shown below \u2014 click <strong>open full Stats</strong> in the strip for the deep view. Not what you meant? <code>not this? \u2715</code> hides it and just searches your text.</li></ul>');
    h.push('<h3>Read</h3><ul>' +
      '<li>Click a title or snippet to read the conversation HERE \u2014 it scrolls straight to the match.</li>' +
      '<li><strong>Find</strong> (or \u2318/Ctrl+F) searches WITHIN the open conversation \u2014 highlights every match and steps through them (Enter / Shift+Enter).</li>' +
      '<li>\uD83D\uDCCE opens the files view: <span style="color:var(--ledger)">green</span> chips carry recoverable text (\u2B07 downloads it); gray ones are binary \u2014 the export holds no bytes, only names (click a <em>name only</em> chip to copy the file name).</li>' +
      '<li>\u2197 opens claude.ai (or the Claude app for Code sessions). There is no way to deep-link a specific message \u2014 claude.ai has no anchors; the reader here IS the workaround. Cowork sessions have no external link at all.</li>' +
      '<li><strong>\ud83d\udccc pins:</strong> pin a conversation (browse rows, result cards, or the reader header) \u2014 it floats to the top of browsing and gets its own \ud83d\udccc tab. Pin a search from the recent \u25be dropdown \u2014 it survives history clearing.</li></ul>');
    h.push('<h3>Compile \u2014 turn chats into skills</h3>' +
      '<p>Your history already contains how you work \u2014 the corrections you give, the rituals you repeat, the decisions you settle. Compile distills that into files an AI can reuse. Everything is extracted from your own messages and auto-redacted; nothing is generated or invented.</p><ul>' +
      '<li><strong>Make me.skill</strong> \u2014 the full about-you skill from the whole archive (or the current chips/filter scope). Works without any AI model.</li>' +
      '<li><strong>Summarize</strong> (in the reader header) and <strong>summary (N)</strong> (next to \u2b07 dossier) \u2014 extractive briefs of one chat or the current set: the ask, key points, decisions, open questions \u2014 every line pulled verbatim.</li>' +
      '<li><strong>Compile a topic</strong> \u2014 type any phrase; the passages closest to it in MEANING become one brief (needs Semantic search on).</li>' +
      '<li><strong>Compile a skill</strong> \u2014 a preset (coding / design / writing) or any phrase \u2192 an installable <code>about-you-&lt;topic&gt;.skill</code> scoped to that topic (needs Semantic search on). Honest gates: a topic your archive doesn\u2019t really contain ABORTS instead of padding thin evidence. <strong>Merge topics with \u201c+\u201d</strong> \u2014 e.g. <code>coding + design</code> compiles ONE skill from both scopes (each side passes the honesty gate on its own).</li>' +
      '<li><strong>Suggest skills</strong> \u2014 ranks the topics YOUR archive can actually support \u2014 curated ones plus clusters discovered in your own conversations \u2014 each with a one-click compile (needs Semantic search on). After a fresh import, a toast proposes this on its own.</li>' +
      '<li>Install any <code>.skill</code>: claude.ai \u2192 Settings \u2192 Capabilities. Not on Claude? Every download also offers the plain <code>.md</code> \u2014 it works as knowledge / instructions in ChatGPT, Gemini, or any assistant. Counts shown are approximate and topics overlap \u2014 the numbers are honest, not decorative.</li></ul>');
    h.push('<h3>Top bar \u2014 Stats, coach, me.skill, backup</h3>' +
      '<p>Click the <span style="color:#ff5c39">orange dot</span> at the very top of the page to open the feature strip:</p><ul>' +
      '<li><strong>Stats</strong> \u2014 time spent, activity heatmap, hours by day, busiest days, records. Estimated from message times, all local. (The <em>ask a question</em> answers open here for the deep view.)</li>' +
      '<li><strong>Make me.skill</strong> \u2014 generate a reusable AI-agent skill from your chat history: a personal about-you skill distilled from your archive (evidence + reading instructions), auto-redacted, zipped in the browser. Install it on claude.ai \u2192 Settings \u2192 Capabilities.</li>' +
      '<li><strong>Token coach</strong> \u2014 track your token usage/spend by month and find waste: messages you retype across chats, files you re-upload, and rework loops (why an assistant keeps forgetting your code, or you keep repeating instructions). It suggests what to move into a skill or CLAUDE.md so you stop re-sending context and re-uploading files. Rough ~chars\u00f74 estimates, all local.</li>' +
      '<li><strong>Entities</strong> \u2014 your technical footprint: the domains, servers (IPs), repos and file paths recurring across the archive, each with counts and a first-seen \u2192 last-seen range. Click one to see every context where you touched it. Extracted with plain patterns, never inferred \u2014 no people, no emails. All local.</li>' +
      '<li><strong>Download archive</strong> \u2014 saves your whole archive (Claude + Code + Cowork) as one local <code>.zip</code>: all message text and text attachments (pasted content, lab results, logs). Binary files like PDFs and images are not included \u2014 the Claude export never carries their bytes, only names. Drop it back onto colloquary here or on another device (your phone is the only way to get Code/Cowork chats there) to import it all. Local download; nothing is uploaded.</li>' +
      '<li><strong>Semantic search</strong> \u2014 an opt-in AI model (self-hosted here) that also finds messages by MEANING, not just keywords; the \u2248 toggle by the search bar folds those matches into your results. Embedding a whole archive is heavy, so phones can\u2019t do it \u2014 instead, on a desktop run <strong>Semantic search</strong>, then <strong>Download embeddings</strong> (one ~50 MB <code>.cvec</code> file), move it to your phone (AirDrop/cloud), import your archive there, and use <strong>Import embeddings</strong>. Then \u2248 works on the phone \u2014 only a live search downloads the model once. The phone follows the .cvec you import \u2014 use <strong>e5</strong> (~118 MB model): it\u2019s the one that runs on phones (the Gemma model\u2019s operator isn\u2019t supported by the phone runtime today; if you import a Gemma .cvec anyway, the app offers the way back to e5).</li>' +
      '<li><strong>Semantic model</strong> \u2014 (desktop) switch the embedding model behind semantic search: <strong>e5</strong> (default) or <strong>EmbeddingGemma</strong>, which matches meaning noticeably more sharply. Switching to Gemma is a one-time ~190 MB self-hosted download plus a re-embed of your archive (roughly an hour \u2014 resumable, it continues where it stopped if you close the tab). Your e5 vectors are kept, so switching back is instant. Search, Compile and Suggest all run on whichever model is active — each has its own calibrated thresholds.</li>' +
      '<li><strong>Clear local data</strong> \u2014 deletes this browser\u2019s archive. Your exports and claude.ai are untouched.</li></ul>');
    h.push('<h3>Privacy</h3>' +
      '<p>Everything stays in this browser (IndexedDB) on this device \u2014 no uploads, no analytics, works offline after first load. The archive is per-browser and per-device: importing on your laptop does not populate your phone. To move it, use <strong>Download archive</strong> and drop the .zip onto colloquary on the other device \u2014 still all local, nothing uploaded.</p>');
    h.push(pageLinksHtml('help'));
    openPage('How to use', 'local-only \u00B7 nothing is uploaded anywhere', h.join(''));
    var hf = $('#help-faq');
    if (hf) hf.addEventListener('click', function (e) { e.preventDefault(); openFaq(); });
    wirePageLinks();
  }

  /* ---------- About + Privacy + diagnostics (v1.45.0) ---------- */
  function openAbout() {
    var h = [];
    h.push('<p>colloquary turns your AI-chat data exports \u2014 Claude, ChatGPT, Claude Code, Cowork \u2014 into a searchable, readable personal archive, and distills what it finds into reusable skills. One file, no account, no backend: everything runs in this browser.</p>');
    h.push('<h3>Why it exists</h3>' +
      '<p>Your conversations with AI are becoming what your photo library already is: years of accumulated thinking. The official exports are zips you can\u2019t practically open, and the chat apps let you scroll history, not use it. colloquary\u2019s bet is that the value isn\u2019t storage \u2014 it\u2019s turning what those chats contain (how you decide, correct, phrase, ship) into capability you can install back into the AI.</p>');
    h.push('<h3>Local-first, honestly</h3>' +
      '<p>\u201CPrivate\u201D here is an architecture, not a promise: the app makes no network requests after the page loads. There is no upload path in the code. The optional semantic model is served from this same domain and runs on your device. Details: <a href="#" id="ab-privacy">privacy</a>.</p>');
    h.push('<h3>Open source \u2014 so you can check</h3>' +
      '<p>A privacy tool you cannot read is just a promise. The page you are using <em>is</em> the source: one HTML file, unminified \u2014 hit View Source and read it. The same code lives at <a href="' + SRC_URL + '" target="_blank" rel="noopener">github.com/egntms/colloquary</a> (AGPL-3.0), where you can also download the file and run it offline from your own disk.</p>');
    h.push('<h3>Who</h3>' +
      '<p>Built by Eugen \u2014 an independent, one-person project. Write me: <a href="mailto:hello@colloquary.com">hello@colloquary.com</a>.</p>');
    h.push('<h3>Feedback & diagnostics</h3>' +
      '<p>Because nothing phones home, the only way I learn anything is if YOU tell me. If something breaks or an idea itches: <a href="mailto:hello@colloquary.com?subject=colloquary%20feedback">send feedback</a>. For bug reports, <button type="button" id="diag-copy" class="btn">Copy diagnostic report</button> puts a short, human-readable summary on your clipboard \u2014 counts and versions only, none of your content. Read it before you paste it into the email; nothing is ever sent automatically.</p>');
    h.push(pageLinksHtml('about'));
    openPage('About', 'colloquary v' + APP_VERSION, h.join(''));
    wirePageLinks();
    var b = $('#diag-copy');
    if (b) b.addEventListener('click', function () {
      buildDiagReport().then(function (txt) {
        navigator.clipboard.writeText(txt).then(
          function () { toast('Diagnostic report copied \u2014 paste it into an email to hello@colloquary.com (read it first: counts only, no content).'); },
          function () { window.prompt('Copy the report:', txt); }
        );
      });
    });
    var pl = $('#ab-privacy');
    if (pl) pl.addEventListener('click', function (e) { e.preventDefault(); openPrivacy(); });
  }
  function openPrivacy() {
    var h = [];
    h.push('<p><strong>The short version: your conversations never leave this browser.</strong></p>');
    h.push('<h3>What the app does with your data</h3>' +
      '<p>Imports are parsed on your device and stored in this browser\u2019s IndexedDB. Search, stats, the token coach, semantic vectors and every compiled skill are computed locally. The app works offline after first load. <strong>Clear data</strong> deletes the archive AND the semantic vectors from this browser; your original export files and your accounts are untouched.</p>');
    h.push('<h3>What the server sees</h3>' +
      '<p>colloquary.com serves static files. Like practically every web server, it keeps standard access logs (IP address, time, requested file) used only to run and secure the service. That is the whole list: no analytics, no cookies, no tracking pixels, no third-party scripts or fonts, and no way for your archive to reach the server \u2014 the app makes no network requests after page load. The one exception you control: opting into Semantic search downloads the AI model, served from this same domain.</p>');
    h.push('<h3>GDPR</h3>' +
      '<p>colloquary collects no personal data. Your imported conversations are processed solely on your device, under your control. To erase everything: <strong>Clear data</strong> (or clear this site\u2019s storage in your browser settings). Questions: <a href="mailto:hello@colloquary.com">hello@colloquary.com</a>.</p>');
    h.push('<h3>Third parties</h3>' +
      '<p>None. No CDNs, no external fonts, no analytics providers, no ad networks. Everything loads from colloquary.com.</p>');
    h.push('<h3>Don’t trust me — check</h3>' +
      '<p>Every claim above is verifiable in about a minute, and that is the point of shipping the code readable:</p>' +
      '<ol>' +
      '<li><strong>Read it.</strong> View Source on this page. The file you were served is the whole app, unminified — the same code as <a href="' + SRC_URL + '" target="_blank" rel="noopener">github.com/egntms/colloquary</a> (AGPL-3.0).</li>' +
      '<li><strong>Watch the network.</strong> Open DevTools → Network, then import your export, search, compile a skill. Nothing goes out.</li>' +
      '<li><strong>Pull the plug.</strong> Go offline and use it. It all still works. (Only the optional semantic model needs one download, once.)</li>' +
      '</ol>');
    h.push(pageLinksHtml('privacy'));
    openPage('Privacy', 'no uploads \u00B7 no analytics \u00B7 no cookies', h.join(''));
    wirePageLinks();
  }
  /* FAQ (v1.45.1) \u2014 organized around the actual jobs the app serves; every recipe is a real,
     runnable query. Examples are deliberately generic (never the developer's own topics). */
  function openFaq() {
    var h = [];
    h.push('<h3>Finding things again</h3><ul>' +
      '<li><strong>I remember an exact phrase.</strong> Put it in quotes: <code>"final version attached"</code> \u2014 matches verbatim, titles included.</li>' +
      '<li><strong>I know roughly when it was.</strong> <code>invoice after:2026-03 before:2026-05</code>, or a single day: <code>on:2026-05-03</code>. Dates accept <code>2026-05</code>, <code>dd.mm.yyyy</code>, dots or slashes.</li>' +
      '<li><strong>There was a file in that chat.</strong> <code>file:contract</code> finds attachments by name; <code>has:attachment</code> lists every chat that carries one.</li>' +
      '<li><strong>I said it \u2014 or the AI did.</strong> <code>from:me deadline</code> vs <code>from:claude deadline</code>.</li>' +
      '<li><strong>It was in ChatGPT, not Claude.</strong> <code>source:chatgpt</code> \u2014 or click the chips above the results; chips COMBINE (e.g. cowork + code), <em>all</em> clears.</li>' +
      '<li><strong>It was a work session in some project.</strong> <code>folder:"my-project"</code> scopes Code/Cowork sessions by working folder (\ud83d\udcc1 chips do the same).</li>' +
      '<li><strong>I only remember the idea, not the words.</strong> Turn on Semantic search once, then the <code>\u2248</code> toggle: \u201cthat chat about negotiating rent\u201d finds \u201cthe landlord wants 200 more\u201d \u2014 meaning, not keywords. Matches found this way are marked <code>\u2248</code>.</li>' +
      '<li><strong>It was in another language.</strong> Keyword search works in ANY language (accents ignored: <code>sapa</code> finds <code>\u0218apa</code>, <code>uber</code> finds <code>\u00fcber</code>). Semantic search understands 100+ languages and matches across them \u2014 search in one language, find the chat you had in another.</li>' +
      '<li><strong>Too many results.</strong> Exclude with <code>-word</code> (<code>tax -crypto</code>), allow alternatives with <code>OR</code> (<code>invoice OR factur\u0103</code>), then <strong>Find</strong> (\u2318/Ctrl+F) steps through matches inside the open chat.</li>' +
      '<li><strong>I keep coming back to the same search.</strong> Pin it: recent \u25be \u2192 \ud83d\udccc. Pin whole conversations too \u2014 they float to the top of browsing.</li></ul>');
    h.push('<h3>Questions it can answer (not just search)</h3><ul>' +
      '<li><code>how many refund chats?</code> \u00b7 <code>how many messages about the thesis</code></li>' +
      '<li><code>how many hours on the renovation?</code> \u00b7 <code>c\u00e2te ore la proiect?</code> \u2014 sessionized time, same math as Stats</li>' +
      '<li><code>when did I first talk about kubernetes?</code> \u2014 earliest + latest mention</li>' +
      '<li><code>how active was I last month</code> \u00b7 <code>how many chats this week</code> \u00b7 <code>\u2026 in 2025</code></li>' +
      '<li>The computed strip covers the SAME conversations listed below it \u2014 <strong>open full Stats \u2197</strong> for the deep view; <code>not this? \u2715</code> if it guessed wrong.</li>' +
      '<li>Question grammar: English + Romanian today. Any other language falls back to plain search \u2014 nothing breaks, you just don\u2019t get the strip.</li></ul>');
    h.push('<h3>Privacy & data</h3><ul>' +
      '<li><strong>Is anything uploaded?</strong> No. The app makes no network requests after page load \u2014 there is no upload path in the code. Architecture, not promise.</li>' +
      '<li><strong>Can you see my searches or archive?</strong> No. Nothing phones home; there are no analytics. The server sees only standard access logs for static files. Details: the privacy page.</li>' +
      '<li><strong>How do I delete everything?</strong> Top bar \u2192 <strong>Clear data</strong> \u2014 wipes the archive AND semantic vectors from this browser. Your exports and accounts are untouched.</li>' +
      '<li><strong>Does it work offline?</strong> Yes, after first load.</li>' +
      '<li><strong>Can I use it on my phone?</strong> Yes: <strong>Download archive</strong> \u2192 one .zip \u2192 open colloquary on the phone and drop it there. For semantic on the phone: embed on desktop \u2192 <strong>Download embeddings</strong> (.cvec) \u2192 <strong>Import embeddings</strong> on the phone. Use an <strong>e5</strong> .cvec \u2014 e5 (~118 MB model) is the one that runs on phones (Gemma\u2019s model doesn\u2019t load on iOS today; the app says so and offers the way back).</li>' +
      '<li><strong>Why is the semantic download large (~120\u2013240 MB)?</strong> That IS the AI model, served from this domain and run on your device \u2014 the price of nothing leaving your browser. One-time.</li>' +
      '<li><strong>Is it open source? Can I verify any of this?</strong> Yes, and please do \u2014 that\u2019s why the code ships readable. The page you\u2019re on <em>is</em> the source (one unminified HTML file: View Source). Same code at <a href="' + SRC_URL + '" target="_blank" rel="noopener">github.com/egntms/colloquary</a> (AGPL-3.0). Two more checks: DevTools \u2192 Network while you use it (nothing goes out), or just go offline and keep working.</li></ul>');
    h.push('<h3>Skills & compile</h3><ul>' +
      '<li><strong>What is a me.skill?</strong> A file distilled from your own messages \u2014 your rituals, corrections, decision patterns \u2014 that you install in Claude (Settings \u2192 Capabilities) so every future session knows how you work.</li>' +
      '<li><strong>What can Compile make?</strong> A brief on any topic (<strong>Compile a topic</strong>), an installable topic-scoped skill (<strong>Compile a skill</strong>: coding / design / writing / any phrase — or merge 2–3 with “+”, e.g. <code>coding + design</code>), or a ranked list of what YOUR archive supports (<strong>Suggest skills</strong>).</li>' +
      '<li><strong>Why did my compile abort?</strong> Honesty gate: if your archive doesn\u2019t really contain the topic, colloquary refuses to pad thin evidence into a confident-looking skill. Try a broader phrase \u2014 or take the abort as the true answer.</li>' +
      '<li><strong>Are the numbers exact?</strong> Counts in Suggest skills are approximate and topics overlap \u2014 they\u2019re shown with \u2248 on purpose.</li>' +
      '<li><strong>Does it only work with Claude?</strong> No. The <code>.skill</code> file is a zip holding one plain-markdown file, written assistant-neutral. Claude installs it natively and auto-loads it when relevant; for anything else, save the plain <code>.md</code> (offered right after every download) and add it as a GPT\u2019s knowledge or custom instructions, a Gemini Gem, or any model\u2019s system prompt. Only the auto-triggering is Claude-specific \u2014 the content travels anywhere.</li></ul>');
    h.push('<h3>Honest limits</h3><ul>' +
      '<li><strong>Some files say \u201cname only\u201d.</strong> The export never carried their bytes \u2014 only names. Pasted/extracted text is fully searchable; uploaded binaries aren\u2019t reopenable anywhere, including the original app.</li>' +
      '<li><strong>\u2197 can\u2019t jump to the exact message.</strong> claude.ai has no message anchors; the reader here IS the workaround. Cowork sessions have no external link at all.</li>' +
      '<li><strong>No model name on claude.ai chats.</strong> That export omits it; ChatGPT and Code/Cowork chats show theirs.</li>' +
      '<li><strong>iPhones can\u2019t embed the archive.</strong> iOS kills the tab under model memory pressure \u2014 use the desktop \u2192 .cvec \u2192 phone flow above.</li></ul>');
    h.push('<p>Something missing here? <a href="mailto:hello@colloquary.com?subject=colloquary%20FAQ">Tell me</a> \u2014 this page grows from real questions.</p>');
    h.push(pageLinksHtml('faq'));
    openPage('FAQ', 'real searches, honest answers', h.join(''));
    wirePageLinks();
  }

  /* counts-only, human-readable \u2014 the user is the transport (reads it, pastes it into an email) */
  function buildDiagReport() {
    var srcCounts = {};
    var lo = '', hi = '';
    state.convs.forEach(function (c) {
      var s = c.source || 'claude';
      srcCounts[s] = (srcCounts[s] || 0) + 1;
      var d = c.updated_at || c.created_at || '';
      if (d) { if (!lo || d < lo) lo = d; if (!hi || d > hi) hi = d; }
    });
    var docs = 0; state.convs.forEach(function (c) { docs += c.docs.length; });
    return semVecCount().then(function (nv) {
      return ['colloquary diagnostic \u2014 ' + new Date().toISOString().slice(0, 10),
        'version: ' + APP_VERSION,
        'browser: ' + navigator.userAgent,
        'webgpu: ' + (!!navigator.gpu) + ' \u00B7 ios: ' + isIOS(),
        'archive: ' + state.convs.size + ' conversations (' + Object.keys(srcCounts).map(function (k) { return k + ' ' + srcCounts[k]; }).join(' \u00B7 ') + ') \u00B7 ' + docs + ' docs',
        'date range: ' + (lo ? lo.slice(0, 10) + ' \u2192 ' + hi.slice(0, 10) : 'n/a'),
        'semantic: model ' + SEM.KEY + ' \u00B7 ' + nv + ' vectors stored \u00B7 hybrid ' + (state.semOn ? 'on' : 'off'),
        'pins: ' + (state.pins || []).length + ' chats \u00B7 ' + (state.pinnedSearches || []).length + ' searches',
        '(counts only \u2014 none of your content is in this report)'].join('\n');
    });
  }

  /* ---------- Stats & chrome ---------- */
  function markActiveTab() {
    var btns = document.querySelectorAll('#src-tabs .stab');
    for (var i = 0; i < btns.length; i++) {
      var ds = btns[i].getAttribute('data-src');
      var act;
      if (ds === '__pinned') act = !!state.pinView;
      else if (ds === '') act = !state.pinView && !state.srcTabs.length;
      else act = !state.pinView && state.srcTabs.indexOf(ds) >= 0;
      btns[i].classList.toggle('active', act);
    }
  }

  function renderStats() {
    /* drop pins whose conversation no longer exists (cleared sample, deleted archive) so the 📌 tab count stays honest */
    if (state.pins.length) {
      var kept = state.pins.filter(function (u) { return state.convs.has(u); });
      if (kept.length !== state.pins.length) { state.pins = kept; setMeta('pinnedConvs', state.pins); if (!kept.length) state.pinView = false; }
    }
    var convs = state.convs.size, msgs = 0, atts = 0, min = null, max = null, needsUpgrade = 0;
    var srcCounts = {};
    state.convs.forEach(function (c) {
      msgs += c.docs.length;
      if (c.schema !== SCHEMA) needsUpgrade++;
      atts += (c.fileNames || []).length;
      var s = c.source || 'claude';
      srcCounts[s] = (srcCounts[s] || 0) + 1;
      var d0 = (c.created_at || '').slice(0, 10), d1 = (c.updated_at || '').slice(0, 10);
      if (d0 && (!min || d0 < min)) min = d0;
      if (d1 && (!max || d1 > max)) max = d1;
    });
    /* sender labels go source-neutral ("me + AI" / "AI only") when a non-Claude assistant (ChatGPT,
       later Gemini) is in the archive — "claude" would be wrong there. Cowork/Code/Project ARE Claude. */
    (function () {
      var fam = { claude: 1, cowork: 1, code: 1, project: 1 };
      var other = Object.keys(srcCounts).some(function (k) { return !fam[k]; });
      var a = other ? 'AI' : 'claude';
      var sel = $('#sender');
      if (sel && sel.options.length >= 3) { sel.options[0].textContent = 'me + ' + a; sel.options[2].textContent = a + ' only'; }
    })();

    /* tab bar appears when the archive mixes sources OR when there are pinned conversations */
    var tabsEl = $('#src-tabs');
    var multiSrc = Object.keys(srcCounts).length > 1;
    if (multiSrc || state.pins.length) {
      var order = ['claude', 'chatgpt', 'cowork', 'code', 'project'].filter(function (k) { return srcCounts[k]; });
      var thtml = '<button class="stab" data-src="">all (' + convs + ')</button>';
      if (state.pins.length) thtml += '<button class="stab stab-pin" data-src="__pinned" title="Show only pinned conversations">📌 ' + state.pins.length + '</button>';
      if (multiSrc) thtml += order.map(function (k) { return '<button class="stab" data-src="' + k + '">' + k + ' (' + srcCounts[k] + ')</button>'; }).join('');
      tabsEl.innerHTML = thtml;
      tabsEl.classList.add('show');
      state.srcTabs = state.srcTabs.filter(function (t) { return srcCounts[t]; });
      markActiveTab();
    } else {
      tabsEl.classList.remove('show');
      tabsEl.innerHTML = '';
      state.srcTabs = [];
      state.pinView = false;
    }
    $('#stat-convs').textContent = convs;
    $('#stat-msgs').textContent = msgs.toLocaleString();
    $('#stat-files').textContent = atts.toLocaleString();
    $('#stat-range').textContent = convs ? (min + ' → ' + max) : '—';
    getMeta('lastImport').then(function (li) {
      $('#stat-import').textContent = li ? li.at.slice(0, 10) : 'never';
    });
    $('#search').disabled = !convs;
    /* the ask-a-question chips stay visible even on an empty archive (discoverability — Eugen):
       a new user sees what they can ask; they become functional once data (or the sample) loads. */
    var db2 = $('#demobar'); if (db2) db2.hidden = !hasDemo();
    if (needsUpgrade) nagOnce('upgradeNagMax', needsUpgrade, 'Upgrade available: re-import once (drop your export zip / re-drag session folders) to add message times to ' + needsUpgrade + ' conversations — powers the new Stats view.');
    else {
      /* sessions imported before v1.11.0 carry no folder tag (project === undefined, not '') */
      var needsFolders = 0;
      state.convs.forEach(function (c) { if (c.source && c.project === undefined) needsFolders++; });
      if (needsFolders) nagOnce('foldersNagMax', needsFolders, 'Folder grouping available: re-drag your sessions folder once to tag ' + needsFolders + ' Cowork/Code sessions.');
    }
  }

  /* v1.30.1: the "re-import to upgrade / re-drag to tag folders" prompts used to toast on EVERY
     page load. Show them once per browser instead, and again only if the count GROWS (a later
     import brought MORE old/untagged sessions) — persisted max per key; re-drag clears the count
     so it naturally goes quiet. */
  function nagOnce(key, count, msg) {
    getMeta(key).then(function (m) {
      if (count > (m || 0)) { toast(msg); setMeta(key, count); }
    });
  }

  function showProgress(stage, pct) {
    $('#progress').style.display = 'block';
    $('#progress-label').textContent = stage;
    $('#progress-bar').style.width = pct + '%';
  }
  function hideProgress() { $('#progress').style.display = 'none'; }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    /* v1.52.0 (advisor catch): a tap-action belongs to ONE toast — showing a new message voids any
       old action, and the fade kills it too, so a stale action can never fire from an unrelated
       later toast. Armers set state._toastAction right AFTER calling toast(). */
    state._toastAction = null;
    el.textContent = msg;
    el.className = isError ? 'error show' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; state._toastAction = null; }, 7000);
  }

  /* ---------- Semantic search (v1.29): lazy model loader ---------- */
  /* HARD RULE: nothing here fetches a single byte until semLoad() runs (opt-in only) — until
     then the app is byte-for-byte the old behavior and the bundle stays ~350 KB.
     Assets are self-hosted on our webroot (/vendor/) — no third-party CDN, never huggingface.co.
     Sizes: lib 0.8 MB + ort wasm 24 MB + tokenizer 17 MB + model (webgpu fp16 235 MB / wasm q8 118 MB). */
  var SEM = {
    KEY: 'e5', LABEL: 'e5-small (384d, default)',
    LIB: '/vendor/transformers.min.js',    /* @huggingface/transformers 3.4.0 (proto-proven) */
    WASM_DIR: '/vendor/',                  /* ort-wasm-simd-threaded.jsep.{mjs,wasm} live here */
    /* (no MODELS_DIR const — see GOTCHA below, the model id itself carries the path) */
    /* v3.4.0 GOTCHA (proven in node with a mocked fetch): env.localModelPath is IGNORED when no
       filesystem is available (i.e. in browsers) — files are fetched at the RAW model id, relative
       to the page. So the id itself must carry the webroot path; MODEL_KEY stays the clean name. */
    MODEL: '/vendor/models/Xenova/multilingual-e5-small',
    MODEL_KEY: 'Xenova/multilingual-e5-small', /* vector store is keyed by THIS — Gemma = drop-in later */
    DIMS: 384,
    QPRE: 'query: ', PPRE: 'passage: ',    /* e5 asymmetric prefixes — required for its quality */
    DTYPE: { webgpu: 'fp16', wasm: 'q8' }, /* fp16@webgpu = measured 23.8 docs/s; q8 = wasm fallback */
    DOC_MIN: 30, DOC_CAP: 1000,            /* proto rules: skip trivial docs, cap long ones */
    BATCH: { webgpu: 16, wasm: 8 },        /* CONSERVATIVE — half the size that crashed WindowServer */
    PASTE_PEN: 0.94,                       /* code/log pastes rank slightly down at query time (tunable) */
    CAL: true,                             /* the compile/suggest gates are calibrated in THIS model's space */
    /* every absolute cosine the compile/suggest surfaces use lives HERE, per model (audit rule:
       these numbers are meaningless outside the model's own space). e5 values = audit cycle 2. */
    GATE: { thinBest: 0.85, thinDelta: 0.10, scopeFloor: 0.76, lensFloor: 0.75, seedFloor: 0.80, coherence: 0.62 }
  };
  /* v1.44.0 — MODEL REGISTRY. SEM is a mutable pointer to the ACTIVE model (semSetModel swaps it);
     the vector store, .cvec files and doc keys are all MODEL_KEY-addressed, so each model's vectors
     coexist and nothing migrates. Gemma decision data = the 2026-07-10 on-device bench (§8):
     MRL-256 doc·seed IQR 0.114 vs e5 0.025, seed-cone mean-NN 0.569 vs 0.887, ~6.4 docs/s ≈ 86 min
     one-time re-embed, and 256d is 0.67× e5's storage (768d would be 2×). CAL:false = the absolute
     compile/suggest gates (0.85/0.10 thin-gate, floors 0.76/0.80, seed FLOOR) are e5-space numbers;
     until s10/s12 are re-run on gemma vectors those surfaces stay pinned to e5 — never guess a gate. */
  var SEM_MODELS = {
    e5: SEM,
    gemma256: {
      KEY: 'gemma256', LABEL: 'EmbeddingGemma-300m (MRL-256d)',
      LIB: '/vendor/v4/transformers.min.js',   /* transformers 4.2 — the SELF-CONTAINED browser bundle
        (LIVE-CAUGHT: dist naming is backwards — .web.min.js is the bundler-only build, §8) */
      WASM_DIR: '/vendor/v4/',                 /* ort-wasm-simd-threaded.asyncify.{mjs,wasm} (ort 1.26-dev) */
      MODEL: '/vendor/models/onnx-community/embeddinggemma-300m-ONNX',
      /* v1.52.2 — iOS runs the NO-GATHER q4 export (194.6 MB, staged in a parallel dir with its
         graph renamed model_q4.onnx): ort's wasm EP lacks GatherBlockQuantized (the v1.52.0 live
         failure, ERROR_CODE 9) and this variant keeps the embed-gather unquantized exactly for such
         runtimes. Same model, same MRL-256 — MODEL_KEY (= the vector namespace) is UNCHANGED. */
      MODEL_IOS: '/vendor/models/onnx-community/embeddinggemma-300m-ONNX-nogather',
      MODEL_KEY: 'onnx-community/embeddinggemma-300m-mrl256',
      DIMS: 256, NATIVE_DIMS: 768,             /* MRL: model emits 768d → stored truncated+renormed to 256d */
      QPRE: 'task: search result | query: ', PPRE: 'title: none | text: ', /* gemma's own prompt format */
      DTYPE: { webgpu: 'q4', wasm: 'q4' },     /* q4 189 MB — the fp32 crashed WindowServer; q4 bench-proven */
      DOC_MIN: 30, DOC_CAP: 1000,
      BATCH: { webgpu: 8, wasm: 8 },           /* batch 8 = the bench's hard guard, keep it */
      PASTE_PEN: 0.94,
      CAL: true,                               /* v1.44.1 — calibrated on the REAL gemma vectors */
      /* CALIBRATED 2026-07-11 (audit_compiler.js s14/s14b on the full 32,972-vector gemma .cvec +
         the s9 seed/probe embeds, MRL-256): absolutes are ALIVE in gemma space — junk/nonsense tops
         out at best 0.423–0.440 while real topics start 0.502 (thinBest 0.48 splits them; e5 never
         could). thinDelta 0.45 keeps the narrow-spike arm (quantum Δ0.469) without rescuing junk
         (junk Δ ≤ 0.387). Verified end-to-end (s14b): all 15 seeds compile 22–61 convs (≈ e5 scopes),
         quantum → <3-conv abort, beekeeping/nonsense → thin abort. seedFloor 0.40 = the argmax sweep's
         knee (51.6% of passages assign, DISTINCT counts ≈ e5-live; 0.35 → 81%, 0.45 → 21%).
         coherence 0.70 actually bites in gemma space (cluster range 0.683–0.941; e5's 0.62 was dead). */
      GATE: { thinBest: 0.48, thinDelta: 0.45, scopeFloor: 0.35, lensFloor: 0.45, seedFloor: 0.40, coherence: 0.70 }
    }
  };
  /* post-process one raw model output vector into what we STORE/SCAN: MRL models are truncated to
     SEM.DIMS + renormalized (a Matryoshka-trained slice is a valid embedding); plain models are
     copied (never keep a view into the runtime's reused output buffer). PURE — node-tested. */
  function semPostVec(data) {
    var d = SEM.DIMS;
    if (!SEM.NATIVE_DIMS || SEM.NATIVE_DIMS === d) return new Float32Array(data);
    var o = new Float32Array(d), n = 0, k;
    for (k = 0; k < d; k++) { o[k] = data[k]; n += o[k] * o[k]; }
    n = Math.sqrt(n) || 1;
    for (k = 0; k < d; k++) o[k] /= n;
    return o;
  }

  /* --- embeddable docs — PURE, no DOM/IDB (node-tested in test_semantic.js) --- */
  function semHash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i); return (h >>> 0).toString(36) + ':' + s.length; }
  function semLooksPaste(t) {
    var lines = t.split('\n'), m = 0;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i], sym = 0;
      for (var j = 0; j < L.length; j++) if ('=<>{};:#()[]|$'.indexOf(L[j]) >= 0) sym++;
      if (sym >= 3 || /^\s{4,}|^\d+[:|\t]/.test(L)) m++;
    }
    return lines.length > 2 && m / lines.length > 0.4;
  }
  /* conv records → list to embed: docs ≥DOC_MIN chars, capped DOC_CAP, title-prefixed ("conv
     title: text" = proto-proven free win), deduped by content hash (identical attachments pasted
     into many chats embed ONCE — same rule as the search index). id = uuid:i matches index doc
     ids so hybrid RRF (task 6) can join the two result lists. Key embeds MODEL_KEY, so a future
     model (Gemma) gets its own vectors — nothing to migrate. */
  function semExtractDocs(convs) {
    var out = [], seen = {};
    convs.forEach(function (c) {
      for (var i = 0; i < c.docs.length; i++) {
        var d = c.docs[i];
        var t = (d.t || '').trim();
        if (t.length < SEM.DOC_MIN) continue;
        if (t.length > SEM.DOC_CAP) t = t.slice(0, SEM.DOC_CAP);
        var text = (c.name ? c.name + ': ' : '') + t;
        var key = SEM.MODEL_KEY + '|' + semHash(text);
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ id: c.uuid + ':' + i, key: key, text: text, paste: d.ty === 'a' ? true : semLooksPaste(t) });
      }
    });
    return out;
  }
  /* Reciprocal Rank Fusion (pure, node-tested): array of ranked id lists → {id: fused score}.
     Standard K=60: rank 1 in one list ≈ 0.0164; present near the top of BOTH lists beats a solo
     #1 — exactly the behavior that fixes multi-proper-noun queries (semantic finds the meaning,
     keyword pins the names). Scores are rank-based, so MiniSearch scores and cosine similarities
     never need to be made comparable. */
  function semRRF(lists, K) {
    K = K || 60;
    var sc = {};
    lists.forEach(function (list) {
      for (var i = 0; i < list.length; i++) sc[list[i]] = (sc[list[i]] || 0) + 1 / (K + i + 1);
    });
    return sc;
  }

  /* --- vector store (task 3): SEPARATE IndexedDB database — the main 'chatalog' DB is untouched:
     no SCHEMA bump, no DB version bump, no re-import. Key = MODEL_KEY|content-hash (content-
     addressed: incremental imports re-embed only what's new; stale keys are simply never asked
     for again), value = Float32Array. --- */
  var semVdbP = null;
  function semVecDB() {
    if (semVdbP) return semVdbP;
    semVdbP = new Promise(function (res, rej) {
      var r = indexedDB.open('chatalog-vectors', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('vecs'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { semVdbP = null; rej(r.error); };
    });
    return semVdbP;
  }
  /* v1.52.0: optional mk = count/range a NON-active model's vectors (the e5-fallback check) */
  function semKeyRange(mk) { var p = (mk || SEM.MODEL_KEY) + '|'; return IDBKeyRange.bound(p, p + '￿'); }
  /* one getAll pass, not 35k point-gets */
  function semVecLoadAll() {
    return semVecDB().then(function (d) {
      return new Promise(function (res, rej) {
        var st = d.transaction('vecs', 'readonly').objectStore('vecs');
        var kq = st.getAllKeys(semKeyRange()), vq = st.getAll(semKeyRange());
        var keys = null, vals = null;
        function fin() {
          if (!keys || !vals) return;
          var out = {};
          for (var i = 0; i < keys.length; i++) out[keys[i]] = vals[i];
          res(out);
        }
        kq.onsuccess = function () { keys = kq.result; fin(); };
        vq.onsuccess = function () { vals = vq.result; fin(); };
        kq.onerror = vq.onerror = function (e) { rej(e.target.error); };
      });
    });
  }
  function semVecPut(pairs) {
    if (!pairs.length) return Promise.resolve();
    return semVecDB().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction('vecs', 'readwrite');
        var st = tx.objectStore('vecs');
        for (var i = 0; i < pairs.length; i++) st.put(pairs[i][1], pairs[i][0]);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function semVecCount(mk) {
    return semVecDB().then(function (d) {
      return new Promise(function (res) {
        var rq = d.transaction('vecs', 'readonly').objectStore('vecs').count(semKeyRange(mk));
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { res(0); };
      });
    });
  }

  /* --- export/import the vector store as ONE portable binary file (.cvec) so a phone gets semantic
     search WITHOUT embedding 32k docs locally (which OOM-reloads iOS Safari). The heavy work stays on
     the desktop; the phone imports the vectors and only ever loads the model to embed a single QUERY.
     Layout: 'CVEC' magic · u8 version · u16 dims · u16 modelKeyLen · modelKey(UTF-8) · u32 count ·
     then per entry: u16 keyLen · key(UTF-8) · dims×float32. All little-endian (every target is LE). --- */
  function semExportBlob() {
    return semVecLoadAll().then(function (map) {
      var keys = Object.keys(map), enc = new TextEncoder();
      var mk = enc.encode(SEM.MODEL_KEY);
      var kb = keys.map(function (k) { return enc.encode(k); });
      var total = 4 + 1 + 2 + 2 + mk.length + 4;
      for (var i = 0; i < keys.length; i++) total += 2 + kb[i].length + SEM.DIMS * 4;
      var buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf), o = 0;
      u8[o++] = 67; u8[o++] = 86; u8[o++] = 69; u8[o++] = 67; /* 'CVEC' */
      dv.setUint8(o, 1); o += 1;
      dv.setUint16(o, SEM.DIMS, true); o += 2;
      dv.setUint16(o, mk.length, true); o += 2;
      u8.set(mk, o); o += mk.length;
      dv.setUint32(o, keys.length, true); o += 4;
      for (var i = 0; i < keys.length; i++) {
        dv.setUint16(o, kb[i].length, true); o += 2;
        u8.set(kb[i], o); o += kb[i].length;
        var v = map[keys[i]];
        u8.set(new Uint8Array(v.buffer, v.byteOffset, SEM.DIMS * 4), o); o += SEM.DIMS * 4;
      }
      return { blob: new Blob([buf], { type: 'application/octet-stream' }), count: keys.length };
    });
  }
  /* v1.52.0: header peek — just the .cvec preamble {mk, dims, count, o = entries offset}. PURE.
     importEmbeddings uses it to offer the phone a model switch BEFORE parsing 50 MB of entries. */
  function cvecHeader(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), o = 0;
    if (u8[0] !== 67 || u8[1] !== 86 || u8[2] !== 69 || u8[3] !== 67) throw new Error('Not a colloquary embeddings (.cvec) file.');
    o = 4;
    dv.getUint8(o); o += 1; /* version (only 1 so far) */
    var dims = dv.getUint16(o, true); o += 2;
    var mkLen = dv.getUint16(o, true); o += 2;
    var mk = new TextDecoder().decode(new Uint8Array(buf, o, mkLen)); o += mkLen;
    var count = dv.getUint32(o, true); o += 4;
    return { mk: mk, dims: dims, count: count, o: o };
  }
  /* v1.50.0: `ios` = a device without the model SWITCHER UI — the cross-model error must name a
     fix the user can perform there. Since v1.52.0 a REGISTERED other model auto-offers a switch in
     importEmbeddings before this runs, so the ios error here only fires for unknown models. */
  function semImportBuffer(buf, ios) {
    var h = cvecHeader(buf);
    if (h.dims !== SEM.DIMS || h.mk !== SEM.MODEL_KEY) {
      var other = Object.keys(SEM_MODELS).filter(function (k2) { return SEM_MODELS[k2].MODEL_KEY === h.mk && SEM_MODELS[k2].DIMS === h.dims; })[0];
      if (ios) throw new Error('These embeddings are for ' + (other ? SEM_MODELS[other].LABEL : h.mk) + ' — this phone runs ' + SEM.LABEL +
        '. On your computer: switch the semantic model to ' + SEM.LABEL + ' (top bar → Semantic model), run Semantic search, then Download embeddings and import THAT file here.');
      throw new Error('These embeddings are for ' + h.mk + ' (' + h.dims + 'd); the active model is ' + SEM.MODEL_KEY + ' (' + SEM.DIMS + 'd).' +
        (other ? ' Switch the semantic model to ' + SEM_MODELS[other].LABEL + ' first (top bar → Semantic model).' : ''));
    }
    var dv = new DataView(buf), o = h.o, dec = new TextDecoder();
    var pairs = [];
    for (var i = 0; i < h.count; i++) {
      var kl = dv.getUint16(o, true); o += 2;
      var key = dec.decode(new Uint8Array(buf, o, kl)); o += kl;
      var v = new Float32Array(h.dims);
      new Uint8Array(v.buffer).set(new Uint8Array(buf, o, h.dims * 4)); o += h.dims * 4;
      pairs.push([key, v]);
    }
    return pairs;
  }

  /* v1.50.0: ask the browser to protect this origin's storage from eviction — iOS Safari deleted
     the vector DB under storage pressure while the archive DB survived (Eugen's iPhone, 2026-07-12).
     Fire-and-forget: a browser that refuses just keeps the status quo. Called after the two heavy
     vector writes (.cvec import, opt-in embed). */
  function reqPersist() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* older browsers */ }
  }

  var semExtractor = null, semDevice = '', semLoading = null;

  /* iPhone/iPad — incl. iPadOS masquerading as "MacIntel" with touch. iOS REPORTS navigator.gpu=true
     but its WebGPU can't hold the 235 MB fp16 model (tab gets memory-killed → the "keeps reloading, no
     toast" bug — a crash, not a catchable error). So on iOS we force the lighter q8 wasm path. */
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  /* Loads transformers.js + the model: webgpu first, wasm fallback — a shipped feature must never
     be able to crash the machine (GOTCHA: 300M model @ webgpu batch 32 killed WindowServer).
     Idempotent: concurrent calls share one load; resolved calls return the cached extractor. */
  function semLoad(onProgress) {
    if (semExtractor) return Promise.resolve(semExtractor);
    if (semLoading) return semLoading;
    var report = onProgress || function () {};
    var prog = function (p) {
      if (p && p.status === 'progress' && p.file && /\.onnx(_data)?$/.test(p.file)) {
        report('Downloading model — ' + Math.round(p.progress || 0) + '%');
      }
    };
    semLoading = import(SEM.LIB).then(function (T) {
      T.env.allowRemoteModels = false;      /* local webroot ONLY — never the HF hub */
      T.env.allowLocalModels = true;        /* v3 defaults this to FALSE in browsers (live-caught 2026-07-08) */
      /* NOTE: env.localModelPath deliberately NOT set — ignored in browsers in 3.4.0, the path
         travels in SEM.MODEL instead (see GOTCHA above). */
      T.env.backends.onnx.wasm.wasmPaths = SEM.WASM_DIR;
      /* iOS Safari isn't cross-origin isolated → no SharedArrayBuffer → multi-threaded wasm can't
         allocate its shared memory and the load fails (then every search retried it = the "keeps
         reloading the model" bug on the phone). Force 1 thread so the threaded-jsep wasm runs WITHOUT
         SAB. Harmless on webgpu (the GPU does the math, not wasm threads). (2026-07-09) */
      try { T.env.backends.onnx.wasm.numThreads = 1; } catch (e) { /* older env shape */ }
      report('Loading model…');
      /* v1.52.2: iOS may need a different EXPORT of the same model (no-gather q4) — path only,
         never a different MODEL_KEY (the vectors must keep joining). */
      var mpath = (isIOS() && SEM.MODEL_IOS) ? SEM.MODEL_IOS : SEM.MODEL;
      var loadWasm = function () {
        report('Loading model (CPU)…');
        return T.pipeline('feature-extraction', mpath, { device: 'wasm', dtype: SEM.DTYPE.wasm, progress_callback: prog })
          .then(function (ex) { return { ex: ex, device: 'wasm' }; });
      };
      /* iOS reports navigator.gpu = true, but its WebGPU can't hold the 235 MB fp16 model — the tab is
         memory-killed and reloads (the "keeps reloading, no toast" bug; self-test on Eugen's iPhone:
         WebGPU true, all files 200, SAB false). Force the lighter q8 wasm (112 MB, single-thread — SAB
         not needed once numThreads=1) on iOS regardless of its WebGPU claim. Non-WebGPU devices → wasm
         too. Desktop with real WebGPU is unchanged (fp16). */
      if (isIOS() || !navigator.gpu) return loadWasm();
      return T.pipeline('feature-extraction', SEM.MODEL, { device: 'webgpu', dtype: SEM.DTYPE.webgpu, progress_callback: prog })
        .then(function (ex) {
          /* warmup compiles shaders; a warmup crash = webgpu failure → same wasm fallback */
          return ex(['warmup'], { pooling: 'mean', normalize: true }).then(function () { return { ex: ex, device: 'webgpu' }; });
        })
        .catch(function (err) {
          console.warn('semantic: webgpu unavailable, falling back to wasm', err);
          return loadWasm();
        });
    }).then(function (r) {
      semExtractor = r.ex; semDevice = r.device; semLoading = null;
      report('Model ready (' + r.device + ')');
      return r.ex;
    }, function (err) {
      semLoading = null;
      throw err;
    });
    return semLoading;
  }

  /* --- embed pipeline (task 4). HARD RULES from the prototype: NO setTimeout yields anywhere in
     the loop (background-tab timer throttling made v1 10× slower — awaited promises are NOT
     throttled); length-bucketed batches (similar-length docs share a batch → less padding waste);
     conservative batch sizes; checkpoint vectors to IDB during the run (a closed tab loses at
     most one flush). Incremental by construction: cache hits skip the model entirely. --- */
  var semRun = { docs: null, vecs: null, busy: false };
  /* v1.44.0 — swap the ACTIVE embedding model. Drops the loaded extractor + in-memory vectors;
     the store is MODEL_KEY-addressed so each model's vectors coexist — switching back to a model
     whose vectors exist is instant (all cache hits, no model download, no re-embed). */
  function semSetModel(key) {
    if (!SEM_MODELS[key] || SEM_MODELS[key] === SEM || semRun.busy) return false;
    SEM = SEM_MODELS[key];
    semExtractor = null; semDevice = ''; semLoading = null;
    semRun.docs = null; semRun.vecs = null;
    return true;
  }
  function semEmbedAll(onStatus) {
    if (semRun.busy) return Promise.reject(new Error('embedding already running'));
    semRun.busy = true;
    var status = onStatus || function () {};
    var docs = semExtractDocs(Array.from(state.convs.values()));
    var vecs = new Array(docs.length).fill(null);
    return semVecLoadAll().then(function (cached) {
      var todo = [];
      docs.forEach(function (d, i) {
        if (cached[d.key]) vecs[i] = cached[d.key];
        else todo.push({ i: i, text: d.text });
      });
      status('docs ' + docs.length + ' — cached ' + (docs.length - todo.length) + ' — to embed ' + todo.length);
      if (!todo.length) return null;
      return semLoad(status).then(function (ex) {
        todo.sort(function (a, b) { return b.text.length - a.text.length; }); /* length buckets */
        var B = SEM.BATCH[semDevice] || 8;
        var t0 = Date.now(), pending = [], done = 0;
        function step(k) {
          if (k >= todo.length) return semVecPut(pending).then(function () { pending = []; });
          var chunk = todo.slice(k, k + B);
          return ex(chunk.map(function (it) { return SEM.PPRE + it.text; }), { pooling: 'mean', normalize: true }).then(function (out) {
            for (var j = 0; j < chunk.length; j++) {
              var v = semPostVec(out[j].data); /* MRL models: truncate+renorm; others: copy */
              vecs[chunk[j].i] = v;
              pending.push([docs[chunk[j].i].key, v]);
            }
            done += chunk.length;
            var rate = done / ((Date.now() - t0) / 1000);
            showProgress('Semantic: embedding ' + done + ' / ' + todo.length + ' — ' + rate.toFixed(1) + ' docs/s', done / todo.length * 100);
            status('embedded ' + done + '/' + todo.length + ' — ' + rate.toFixed(1) + ' docs/s — ETA ' + Math.round((todo.length - done) / Math.max(rate, 0.1)) + 's');
            var flush = pending.length >= 512 ? semVecPut(pending).then(function () { pending = []; }) : Promise.resolve();
            return flush.then(function () { return step(k + B); });
          });
        }
        return step(0);
      });
    }).then(function () {
      semRun.docs = docs; semRun.vecs = vecs; semRun.busy = false;
      hideProgress();
      var have = 0;
      for (var i = 0; i < vecs.length; i++) if (vecs[i]) have++;
      status('READY: ' + have + '/' + docs.length + ' vectors');
      return { docs: docs.length, vectors: have };
    }, function (err) { semRun.busy = false; hideProgress(); throw err; });
  }

  /* query → top-N semantic doc hits over the in-memory vectors (e5 'query: ' prefix, dot product
     on normalized vecs = cosine; paste down-rank ×PASTE_PEN). id/convUuid/idx/date = the join keys
     hybrid RRF (semAugment) uses against MiniSearch results. */
  function semScan(q, n) {
    if (!semRun.docs) return Promise.reject(new Error('no vectors in memory'));
    return semLoad().then(function (ex) {
      return ex([SEM.QPRE + q], { pooling: 'mean', normalize: true });
    }).then(function (out) {
      var qv = semPostVec(out[0].data), docs = semRun.docs, vecs = semRun.vecs;
      var scored = [];
      for (var i = 0; i < docs.length; i++) {
        var v = vecs[i]; if (!v) continue;
        var s = 0;
        for (var k = 0; k < SEM.DIMS; k++) s += qv[k] * v[k];
        if (docs[i].paste) s *= SEM.PASTE_PEN;
        scored.push([s, i]);
      }
      scored.sort(function (a, b) { return b[0] - a[0]; });
      var hits = scored.slice(0, n || 10).map(function (p) {
        var d = docs[p[1]];
        var uuid = d.id.slice(0, d.id.lastIndexOf(':'));
        var idx = parseInt(d.id.slice(d.id.lastIndexOf(':') + 1), 10);
        var c = state.convs.get(uuid);
        var doc = c && c.docs[idx];
        return { id: d.id, convUuid: uuid, idx: idx, score: p[0], date: doc ? doc.d : '', paste: d.paste };
      });
      /* audit-cycle-2 fix 1: the query's own score distribution rides along on the result array, so
         callers can gate RELATIVELY — in e5 space an absolute cosine alone means nothing (§8). */
      if (scored.length) hits.qstats = { best: scored[0][0], median: scored[Math.floor(scored.length / 2)][0], n: scored.length };
      return hits;
    });
  }
  /* console-friendly view of semScan (kept for debugging even after the UI lands) */
  function semSearch(q, n) {
    return semScan(q, n).then(function (hits) {
      return hits.map(function (h) {
        var c = state.convs.get(h.convUuid);
        var doc = c && c.docs[h.idx];
        return { score: +h.score.toFixed(3), conv: c ? c.name : '?', date: dDay(h.date), paste: h.paste, snippet: doc ? doc.t.slice(0, 120) : '' };
      });
    });
  }

  /* vectors exist in IDB but not in memory (fresh page load with the toggle ON): rebuild semRun
     from the store. The model is NOT loaded unless something new needs embedding — the all-cached
     path never touches the network. */
  function semEnsureDocs() {
    if (semRun.docs) return Promise.resolve(true);
    if (semRun.busy) return Promise.resolve(false);
    return semVecCount().then(function (n) {
      if (!n) return false;
      /* v1.52.0 (advisor blocker): a phone must NEVER enter the embed pipeline — Compile / Suggest /
         the lazy arm all come through here, and a .cvec that misses a few docs would silently
         download the model + start an on-device embed (the v1.50.3 lesson, now enforced at the one
         choke point). Read-only rebuild; uncovered docs stay keyword-only. */
      if (isIOS()) return semRebuildFromStore().then(function (h) { return h > 0; });
      return semEmbedAll(function () {}).then(function () { return true; }, function () { return false; });
    });
  }
  /* rebuild the in-memory vectors from the store WITHOUT embedding anything (no model download) —
     used after importing a .cvec on a phone. Docs whose key isn't in the store just stay null and are
     skipped at scan time; a mismatched archive can never kick off a bulk embed on mobile. */
  function semRebuildFromStore() {
    var docs = semExtractDocs(Array.from(state.convs.values()));
    return semVecLoadAll().then(function (cached) {
      var vecs = new Array(docs.length).fill(null), have = 0;
      for (var i = 0; i < docs.length; i++) { var v = cached[docs[i].key]; if (v) { vecs[i] = v; have++; } }
      semRun.docs = docs; semRun.vecs = vecs;
      return have;
    });
  }
  /* ---------- compiler mode 4: AUTO-SUGGEST lenses (2026-07-10) ----------
     Rank the richest skills THIS archive can produce, so the user doesn't have to guess a phrase.
     HYBRID (Eugen's pick): (A) score a curated candidate LIBRARY (the 3 presets + ~12 common topics)
     by evidence density — clean names + kw filters; (B) k-means the per-CONVERSATION vectors to
     DISCOVER topics the library misses, labelled by their top distinctive title-terms (TF-IDF). Merge,
     DROP thin evidence (never pad a skill), rank by on-topic conversation count. All local, over the
     in-memory semRun vectors — no extra model work beyond embedding the ~15 seed phrases once. */

  /* the ~12 generic seeds beyond the 3 presets (coding/design/writing). Broad + cross-domain so the
     curated half is useful to any archive; discovered clusters cover whatever these miss. */
  var SUGGEST_SEEDS = [
    { label: 'deployment & infra', lens: 'deployment, servers, hosting, nginx, dns, ssl, devops, vps, ci cd, releases',
      intro: 'How this user ships and runs things — deploy steps, servers, and infra conventions.', useWhen: 'deploying, configuring servers, or working with infrastructure' },
    { label: 'debugging', lens: 'debugging, errors, bugs, crashes, stack traces, troubleshooting, root cause, fixing',
      intro: 'How this user hunts and fixes bugs — their debugging method and what they expect.', useWhen: 'debugging, chasing an error, or diagnosing a failure' },
    { label: 'databases & data', lens: 'database, sql, queries, schema, migrations, data modeling, tables, indexes',
      intro: 'How this user works with data and databases — modeling, queries, and migrations.', useWhen: 'designing schemas, writing queries, or handling data' },
    { label: 'apis & backend', lens: 'api, backend, endpoints, requests, authentication, integration, webhooks, services',
      intro: 'How this user builds backends and integrates services — API and auth conventions.', useWhen: 'building an API, an endpoint, or a backend integration' },
    { label: 'product & naming', lens: 'product decisions, naming, branding, features, roadmap, positioning, launch',
      intro: 'How this user makes product calls — naming, scope, and what to build.', useWhen: 'making product decisions, naming, or scoping features' },
    { label: 'marketing & seo', lens: 'marketing, seo, growth, landing page, ads, keywords, analytics, conversion',
      intro: 'How this user approaches marketing and growth — SEO, copy, and channels.', useWhen: 'working on marketing, SEO, or growth' },
    { label: 'project management', lens: 'project management, planning, scheduling, tasks, deadlines, coordination, milestones, budget',
      intro: 'How this user runs projects — planning, tracking, and coordination.', useWhen: 'planning, scheduling, or coordinating a project' },
    { label: 'testing & qa', lens: 'testing, unit tests, qa, verification, test suite, assertions, coverage, regression',
      intro: 'How this user tests and verifies — their bar for what "tested" means.', useWhen: 'writing tests, verifying, or doing QA' },
    { label: 'documentation', lens: 'documentation, notes, guide, readme, handover, reference, changelog, how-to',
      intro: 'How this user writes and keeps docs — structure and what they capture.', useWhen: 'writing documentation, notes, or a handover' },
    { label: 'data analysis', lens: 'data analysis, statistics, charts, spreadsheet, metrics, dashboard, trends, report',
      intro: 'How this user analyzes data — metrics, charts, and how they read results.', useWhen: 'analyzing data, building charts, or reporting metrics' },
    { label: 'finance & budgeting', lens: 'finance, budget, costs, pricing, invoices, accounting, revenue, expenses',
      intro: 'How this user handles money matters — budgets, pricing, and costs.', useWhen: 'working on budgets, pricing, or finances' },
    { label: 'learning & research', lens: 'learning, research, explanation, concepts, how it works, comparison, background, understanding',
      intro: 'How this user learns and researches — the depth and format they want.', useWhen: 'researching, explaining a concept, or learning something new' }
  ];

  /* deterministic RNG (seeded) so k-means + its tests are reproducible run-to-run */
  function sgRand(seed) { var s = (seed >>> 0) || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function sgDot(a, b, d) { var s = 0; for (var k = 0; k < d; k++) s += a[k] * b[k]; return s; }
  /* audit-cycle-2 fix 1 — thin-lens gate, CALIBRATED on the real archive (audit_compiler.js s10):
     a lens is compilable if its best match is strong in absolute terms (real topics measured
     0.857–0.912 vs absent/nonsense ≤ 0.840) OR spikes far above the archive's own median (narrow
     real topic: "quantum computers" Δ 0.139 vs absent ≤ 0.079). NOTE: a pure Δ-gate FAILED
     calibration — broad present topics raise the median too (coding Δ 0.056) — hence the OR. */
  function semLensThin(best, median) { return !(best >= SEM.GATE.thinBest || (best - median) >= SEM.GATE.thinDelta); } /* v1.44.1: per-model GATE */
  /* fix 1b — adaptive per-doc floor for the compile scope (replaces the absolute 0.76, which the
     audit showed rejects NOTHING): halfway between the archive's median and the query's best.
     Measured: preset scopes unchanged (42/47/65 convs), garbage tails trimmed. */
  function semLensFloor(best, median) { return Math.max(SEM.GATE.scopeFloor, median + 0.5 * (best - median)); } /* v1.44.1: per-model GATE */
  /* fix 2 — the seed library's OWN cone width: max pairwise seed similarity. A discovered cluster
     is deduped against a seed only above this (self-calibrating; ≈0.92 on the audited archive —
     the fixed 0.88 sat INSIDE the cone and killed every real project cluster). */
  function sgMaxNN(vecs, d) {
    var mx = -2;
    for (var i = 0; i < vecs.length; i++) for (var j = i + 1; j < vecs.length; j++) { var s = sgDot(vecs[i], vecs[j], d); if (s > mx) mx = s; }
    return mx;
  }
  /* fix 3 — honest counts: the ranking carries ±20% embedding noise (audit §5 F1), so show ≈rounded */
  function sgApprox(n) {
    if (n < 20) return String(n);
    var r = n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n / 10) * 10;
    return '≈' + r;
  }
  /* mean of unit vectors, renormalized → a centroid on the unit sphere (cosine geometry) */
  function sgCentroid(vecs, d) {
    var c = new Float32Array(d), i, k;
    for (i = 0; i < vecs.length; i++) for (k = 0; k < d; k++) c[k] += vecs[i][k];
    var n = 0; for (k = 0; k < d; k++) n += c[k] * c[k]; n = Math.sqrt(n) || 1;
    for (k = 0; k < d; k++) c[k] /= n;
    return c;
  }
  /* spherical k-means (cosine): unit-vector points, assign by max dot, recompute centroids as
     renormalized means. Deterministic via a seeded RNG. v1.43.0 (cluster-granularity fix, measured in
     audit_compiler.js s13): the old farthest-point seeding was outlier-prone and UNSTABLE — dropping
     4 convs from the real archive swung the biggest cluster from 20% to 62% of everything (that was
     the live "≈200-conv fits cluster"). Now: FULL k-means++ (D² sampling) seeding × 5 RESTARTS, keep
     the run with the best mean point-to-centroid similarity — worst-case mega-cluster measured down
     to ~30% and the ≥5-conv cluster count steadies at 13–16. Still deterministic (one seeded rnd
     drives all restarts) and trivial at this size (~416 points × 5 runs). */
  function sgKmeans(points, k, iters, d, rnd) {
    var N = points.length;
    if (N === 0) return { assign: [], cent: [], cohere: [], count: [] };
    k = Math.max(1, Math.min(k, N));
    rnd = rnd || sgRand(1);
    function seedPP() { /* full k-means++: next centre sampled ∝ (1 − nearest-sim)² */
      var cent = [Float32Array.from(points[Math.floor(rnd() * N)])];
      while (cent.length < k) {
        var d2 = new Array(N), sum = 0;
        for (var i = 0; i < N; i++) {
          var mx = -2; for (var c = 0; c < cent.length; c++) { var s = sgDot(points[i], cent[c], d); if (s > mx) mx = s; }
          var w = Math.max(0, 1 - mx); d2[i] = w * w; sum += d2[i];
        }
        if (!sum) break; /* all points already coincide with a centre */
        var r = rnd() * sum, acc = 0, pick = N - 1;
        for (var p = 0; p < N; p++) { acc += d2[p]; if (acc >= r) { pick = p; break; } }
        cent.push(Float32Array.from(points[pick]));
      }
      return cent;
    }
    function lloyd(cent) {
      var assign = new Array(N).fill(0), it, moved;
      for (it = 0; it < iters; it++) {
        moved = 0;
        for (var p = 0; p < N; p++) {
          var best = 0, bv = -2;
          for (var cc = 0; cc < cent.length; cc++) { var dv = sgDot(points[p], cent[cc], d); if (dv > bv) { bv = dv; best = cc; } }
          if (assign[p] !== best) { assign[p] = best; moved++; }
        }
        var buckets = []; for (var b = 0; b < cent.length; b++) buckets.push([]);
        for (var q = 0; q < N; q++) buckets[assign[q]].push(points[q]);
        for (var bb = 0; bb < cent.length; bb++) if (buckets[bb].length) cent[bb] = sgCentroid(buckets[bb], d);
        if (!moved) break;
      }
      var cohere = [], count = [], quality = 0;
      for (var z = 0; z < cent.length; z++) { cohere.push(0); count.push(0); }
      for (var m = 0; m < N; m++) { var sm = sgDot(points[m], cent[assign[m]], d); cohere[assign[m]] += sm; count[assign[m]]++; quality += sm; }
      for (var y = 0; y < cent.length; y++) cohere[y] = count[y] ? cohere[y] / count[y] : 0;
      return { assign: assign, cent: cent, cohere: cohere, count: count, quality: quality / N };
    }
    var best = null;
    for (var r2 = 0; r2 < 5; r2++) {
      var km = lloyd(seedPP());
      if (!best || km.quality > best.quality) best = km;
    }
    return best;
  }
  /* tokenize a conversation title into content terms (lowercase words ≥3 chars, stopwords dropped) */
  function sgTokens(s) {
    var ws = String(s || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
    var out = [], seen = {};
    for (var i = 0; i < ws.length; i++) { var w = ws[i]; if (MS_STOP[w] || seen[w]) continue; seen[w] = 1; out.push(w); }
    return out;
  }
  /* TF-IDF label: score each cluster term by (freq across member titles) × log(N/df); return the top
     terms. df = conversation-title document frequency across the whole archive, so a ubiquitous word
     (e.g. the user's own opener) can't win a cluster's label. Pure. */
  function sgTopTerms(memberTitles, df, N, top) {
    var tf = {};
    memberTitles.forEach(function (t) { sgTokens(t).forEach(function (w) { tf[w] = (tf[w] || 0) + 1; }); });
    var scored = Object.keys(tf).map(function (w) { return [w, tf[w] * Math.log((N + 1) / ((df[w] || 0) + 1))]; })
      .filter(function (p) { return p[1] > 0; });
    scored.sort(function (a, b) { return b[1] - a[1]; });
    /* audit-cycle-2 fix 2: stem-dedupe the label — "resume · resuming" wasted label slots (a picked
       term blocks any later term sharing its 5-char stem or a prefix relationship). */
    var out = [];
    for (var i = 0; i < scored.length && out.length < (top || 4); i++) {
      var w = scored[i][0];
      var dup = out.some(function (p) { return p.slice(0, 5) === w.slice(0, 5) || p.indexOf(w) === 0 || w.indexOf(p) === 0; });
      if (!dup) out.push(w);
    }
    return out;
  }

  /* build the ranked proposals. Async only to embed the ~15 seed phrases once (model already cached
     if the user has used semantic); everything else is local over the in-memory vectors. */
  function semSuggest(onStep) {
    /* v1.44.0 honesty gate: every ranking constant here (seed FLOOR 0.80, ≥2-passage rule, MINCONV,
       coherence) was calibrated on REAL e5 vectors (audit cycle 2). Under an uncalibrated model we
       abort rather than rank with wrong numbers — the audit's own rule. suggestNudge swallows this. */
    if (!SEM.CAL) return Promise.reject(new Error('Suggest skills is calibrated for e5 — switch the semantic model back to e5 (top bar → Semantic model). Gemma calibration is the next update.'));
    var step = onStep || function () {};
    var D = SEM.DIMS;
    return semEnsureDocs().then(function () {
      if (!semRun.docs || !semRun.docs.length) throw new Error('no vectors in memory');
      /* per-conversation centroid + passage count + a title corpus for labelling/df */
      var byConv = {}, order = [];
      for (var i = 0; i < semRun.docs.length; i++) {
        var v = semRun.vecs[i]; if (!v) continue;
        var id = semRun.docs[i].id, uuid = id.slice(0, id.lastIndexOf(':'));
        if (!byConv[uuid]) { byConv[uuid] = []; order.push(uuid); }
        byConv[uuid].push(v);
      }
      var convVecs = [], convMeta = [], df = {}, N;
      order.forEach(function (u) {
        var c = state.convs.get(u); if (!c) return;
        convVecs.push(sgCentroid(byConv[u], D));
        convMeta.push({ uuid: u, name: c.name || '', passages: byConv[u].length });
        var seen = {}; sgTokens(c.name).forEach(function (w) { if (!seen[w]) { seen[w] = 1; df[w] = (df[w] || 0) + 1; } });
      });
      N = convVecs.length;
      if (N < 6) return [];
      var seeds = [];
      ['coding', 'design', 'writing'].forEach(function (k) { var r = SKILL_RECIPES[k]; seeds.push({ label: r.label, lens: r.lens, kw: r.kw, intro: r.intro, useWhen: r.useWhen }); });
      SUGGEST_SEEDS.forEach(function (s) { seeds.push(s); });
      step('embedding topic seeds…', 20);
      return semLoad(function (m) { var mt = /(\d+)\s*%/.exec(m); step(m, mt ? Math.max(20, +mt[1]) : 20); }).then(function (ex) {
        return ex(seeds.map(function (s) { return SEM.QPRE + s.lens; }), { pooling: 'mean', normalize: true });
      }).then(function (out) {
        step('scoring your topics…', 92);
        var seedVecs = seeds.map(function (s, i) { return semPostVec(out[i].data); });
        /* (A) seeded evidence density — WINNER-TAKE-ALL (v1.40.3, fixes the degenerate ranking Eugen caught
           live: a per-seed absolute floor let every seed match ~the WHOLE archive, because e5 scores are
           compressed to ~0.80–0.87, §8). Each passage counts toward its SINGLE best-matching seed (argmax
           above FLOOR), so topics PARTITION the archive → discriminative, honest counts. A conv is "about" a
           seed at ≥2 assigned passages (same rule compile-a-skill uses); hide seeds under MINCONV convs. */
        var FLOOR = SEM.GATE.seedFloor, MINCONV = 5; /* v1.44.1: per-model (e5 0.80 · gemma 0.40, the sweep knee) */
        var seedAcc = seeds.map(function () { return { perConv: {}, passages: 0, scoreSum: 0 }; });
        for (var di = 0; di < semRun.docs.length; di++) {
          var dv2 = semRun.vecs[di]; if (!dv2) continue;
          var bestSi = -1, bestSc = FLOOR;
          for (var si = 0; si < seedVecs.length; si++) { var sc = sgDot(seedVecs[si], dv2, D); if (sc > bestSc) { bestSc = sc; bestSi = si; } }
          if (bestSi < 0) continue; /* no seed clears the floor → this passage is about none of them */
          var id2 = semRun.docs[di].id, uuid2 = id2.slice(0, id2.lastIndexOf(':')), acc = seedAcc[bestSi];
          acc.perConv[uuid2] = (acc.perConv[uuid2] || 0) + 1; acc.passages++; acc.scoreSum += bestSc;
        }
        var seedProps = seeds.map(function (s, si) {
          var acc = seedAcc[si], convs = Object.keys(acc.perConv).filter(function (u) { return acc.perConv[u] >= 2; });
          return { kind: 'seed', label: s.label, lens: s.lens, kw: s.kw, intro: s.intro, useWhen: s.useWhen,
            convCount: convs.length, passages: acc.passages, avg: acc.passages ? acc.scoreSum / acc.passages : 0 };
        }).filter(function (p) { return p.convCount >= MINCONV; });
        /* (B) discovered clusters over the conversation vectors, labelled by distinctive title-terms.
           audit-cycle-2 fix 2: K≈N/12 clamped ≤14 was too coarse — one 189-conv "resume sessions"
           super-cluster mixed every project; at K≈N/8 (≤28) the real projects split out cleanly. */
        var K = Math.max(6, Math.min(28, Math.round(N / 8)));
        var km = sgKmeans(convVecs, K, 14, D, sgRand(1234));
        /* fix 2: dedup vs seeds is RELATIVE — the fixed 0.88 sat inside the e5 seed cone (every seed's
           own NN is 0.865–0.917) and killed every real project cluster (measured: a real project at 0.901 was eaten by "debugging"). A
           cluster now only counts as a seed's topic if it's closer to that seed than seeds are to each other. */
        var seedNN = sgMaxNN(seedVecs, D);
        var seedLabels = {}; seedProps.forEach(function (p) { seedLabels[p.label] = 1; });
        var discProps = [];
        for (var ci = 0; ci < km.cent.length; ci++) {
          if ((km.count[ci] || 0) < MINCONV || km.cohere[ci] < SEM.GATE.coherence) continue; /* v1.44.1: per-model (gemma 0.70 actually bites) */
          var near = 0; for (var s2 = 0; s2 < seedVecs.length; s2++) { var d2 = sgDot(km.cent[ci], seedVecs[s2], D); if (d2 > near) near = d2; }
          if (near >= seedNN) continue; /* closer to a seed than seeds are to each other → the seed name wins */
          var titles = [], passc = 0, medoid = '', medoidS = -2;
          for (var mi = 0; mi < convMeta.length; mi++) if (km.assign[mi] === ci) {
            titles.push(convMeta[mi].name); passc += convMeta[mi].passages;
            var ms = sgDot(convVecs[mi], km.cent[ci], D); if (ms > medoidS) { medoidS = ms; medoid = convMeta[mi].name; }
          }
          var terms = sgTopTerms(titles, df, N, 4);
          if (terms.length < 2) continue; /* no coherent label → don't show a mystery topic */
          var label = terms.join(' · ');
          if (seedLabels[label]) continue;
          discProps.push({ kind: 'discovered', label: label, lens: terms.join(', '), kw: null,
            intro: 'How this user works on ' + terms.join(', ') + ', distilled from the conversations that cluster here.',
            useWhen: terms.slice(0, 3).join(', ') + ' come up',
            convCount: km.count[ci], passages: passc, avg: km.cohere[ci], sample: medoid });
        }
        /* rank by on-topic conversation count (tiebreak avg score), cap 8 — but RESERVE up to 3 slots for
           discovered clusters so the HYBRID always surfaces discovery, not just the curated library. */
        var byCount = function (a, b) { return (b.convCount - a.convCount) || (b.avg - a.avg); };
        var out = seedProps.concat(discProps).sort(byCount).slice(0, 8);
        var disc = discProps.slice().sort(byCount);
        var haveDisc = out.filter(function (p) { return p.kind === 'discovered'; }).length;
        var want = Math.min(3, disc.length);
        for (var e = 0; haveDisc < want && e < disc.length; e++) {
          if (out.indexOf(disc[e]) >= 0) continue;
          for (var k = out.length - 1; k >= 0; k--) { if (out[k].kind === 'seed') { out.splice(k, 1); break; } }
          out.push(disc[e]); haveDisc++;
        }
        return out.sort(byCount).slice(0, 8);
      });
    });
  }

  /* shared distill core: recipe {label, lens, intro, useWhen, kw?} + a first name → an installable
     .skill (preview + download). Used by BOTH the "Compile a skill" prompt and a Suggest-skills click. */
  function compileSkillFromRecipe(recipe, nm) {
    /* v1.44.0 honesty gate: semLensThin/semLensFloor (0.85 / Δ0.10 / floor 0.76) are e5-space
       calibrations — under an uncalibrated model they'd accept nonsense or abort everything. */
    if (!SEM.CAL) { toast('Compile is calibrated for e5 — switch the semantic model back to e5 (top bar → Semantic model). Gemma calibration is the next update.', true); return Promise.resolve(); }
    recipe.person = nm;
    /* v1.46.0 — MERGE SKILLS: recipe.parts (2–3 lenses) compiles ONE skill from the UNION of the
       per-lens scopes; a single recipe takes the same path with one part (identical result). */
    var parts = recipe.parts || [{ label: recipe.label, lens: recipe.lens, kw: recipe.kw }];
    var lab = 'Compiling the ' + recipe.label + ' skill';
    showProgress(lab + ' — preparing…', 5);
    return semEnsureDocs().then(function () {
      showProgress(lab + ' — loading the model…', 20);
      return semLoad(function (m) { var mt = /(\d+)\s*%/.exec(m); showProgress(lab + ' — ' + m, mt ? Math.max(20, +mt[1]) : 20); });
    }).then(function () {
      /* one semScan per part, sequential (the query embeds share the loaded model) */
      var scans = [], seq = Promise.resolve();
      parts.forEach(function (p) {
        seq = seq.then(function () {
          showProgress(lab + ' — selecting on-topic conversations' + (parts.length > 1 ? ' (' + p.label + ')' : '') + '…', 92);
          return semScan(p.lens, 400).then(function (h) { scans.push(h); });
        });
      });
      return seq.then(function () { return scans; });
    }).then(function (scans) {
      /* audit-cycle-2 fix 1: honest thin-lens abort. The old absolute floor 0.76 rejected NOTHING —
         a nonsense phrase compiled a confident 61-conversation skill. Gate + floor are RELATIVE to
         this archive's own score distribution (semLensThin/semLensFloor, calibrated in AUDITS §8 F1).
         In a merge the gate runs PER PART — a thin side aborts honestly instead of padding the union. */
      var i, st;
      for (i = 0; i < parts.length; i++) {
        st = scans[i].qstats;
        if (st && semLensThin(st.best, st.median)) {
          hideProgress();
          toast('Your archive doesn’t have enough about “' + parts[i].label + '” to compile an honest skill (best relevance ' + st.best.toFixed(2) + ', archive baseline ' + st.median.toFixed(2) + ') — try a different phrase.', true);
          return;
        }
      }
      /* per-part selection (each part keeps its own adaptive floor + the ≥2-passage "about" rule),
         then a ROUND-ROBIN union via mergeFill — audit cycle 3 (§12): the old part-order fill +
         final slice starved later parts to zero while perCount showed their pre-cap numbers */
      var sels = parts.map(function (p, pi) {
        var hits = scans[pi], stp = hits.qstats;
        var floor = stp ? semLensFloor(stp.best, stp.median) : 0.76;
        var byConv = {}, order = [];
        hits.forEach(function (h) {
          if (h.score < floor || !state.convs.get(h.convUuid)) return;
          if (!(h.convUuid in byConv)) { byConv[h.convUuid] = 0; order.push(h.convUuid); }
          byConv[h.convUuid]++;
        });
        var strong = order.filter(function (u) { return byConv[u] >= 2; });
        return (strong.length >= 8 ? strong : order).slice(0, 150);
      });
      var fill = mergeFill(sels, 150);
      var perCount = fill.perCount;
      var chosen = fill.order.map(function (u) { return state.convs.get(u); }).filter(Boolean);
      if (chosen.length < 3) { hideProgress(); toast('Not enough “' + recipe.label + '” conversations to distill a skill — try a broader phrase.', true); return; }
      showProgress(lab + ' — distilling the pattern…', 97);
      /* kw = the OR of the parts' predicates (preset regex, or derived from that part's phrase) */
      var regs = parts.map(function (p) {
        if (p.kw) return p.kw;
        var words = (p.lens.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter(function (w) { return !MS_STOP[w]; });
        return words.length ? new RegExp('\\b(' + words.join('|') + ')', 'i') : null;
      }).filter(Boolean);
      var pack = buildProfilePack(chosen, regs.length ? function (t) { return regs.some(function (r) { return r.test(t); }); } : null);
      pack.scope = recipe.label + ' lens' + (parts.length > 1 ? 'es' : '') + ' (' + chosen.length + ' of ' + state.convs.size + ' conversations)';
      var fullName = nm + '-' + recipeSlug(recipe.label);
      var md = renderMeSkill(fullName, pack, recipe);
      hideProgress();
      var deltas = (pack.critiques || []).length, rit = (pack.rituals || []).length;
      var covScope = parts.length > 1
        ? chosen.length + ' conversations (' + parts.map(function (p, pi) { return p.label + ' ' + perCount[pi]; }).join(' · ') + ', overlap deduped)'
        : chosen.length + ' ' + recipe.label + ' conversations';
      deliverSkill(recipe.label + ' skill — preview (review before installing)', fullName, md,
        'Compiled about-' + fullName + ' — ' + covScope + ' · ' + deltas + ' on-topic deltas · ' + rit + ' rituals.');
    }).catch(function (e) { hideProgress(); toast('Compile-a-skill failed: ' + ((e && e.message) || e), true); });
  }

  /* v1.47.0 — the Entities page: "every context where I touched this server / repo / path".
     Follows the active scope like Stats; a row click runs a quoted search for the entity. */
  var ENT_LABELS = { domain: 'Domains & hosts', ip: 'IP addresses', repo: 'Repos', path: 'Paths' };
  function openEntities() {
    if (!state.convs.size) { toast('Import your archive first — entities are extracted from it, locally.'); return; }
    var scope = viewScope();
    var slist = scope ? scope.list : Array.from(state.convs.values());
    var idx = entIndex(slist);
    var html = ['<p class="note">Your technical footprint — the domains, servers, repos and paths that recur across this archive. Extracted with plain patterns from your messages and files, never inferred (no people, no emails); shown only when an entity appears in ≥2 conversations. Click one to see every context where you touched it. Computed locally; nothing leaves this browser.</p>'];
    var total = 0;
    /* v1.48.0 — one shared axis + the cross-reference map, over the SHOWN rows (top 40/kind) */
    var kept = [];
    Object.keys(ENT_LABELS).forEach(function (k) { kept = kept.concat((idx[k] || []).slice(0, 40)); });
    var axis = entAxis(kept), co = entCoocc(kept);
    /* v1.49.0 — Eugen's pick: every entity IS the full cassette, inline — name+kind · stats incl.
       busiest · the labeled chart · top conversations · appears-with. Self-contained rows; the
       v1.48.2/.3 hover-card + bottom-sheet machinery is GONE (redundant, and it carried two
       bubbling traps). entPopHtml is reused as the card body (opts.link + opts.coHtml). */
    if (axis.length) html.push('<p class="hleg">each card: mentions per month, one bar per month — height relative to that entity’s own busiest month</p>');
    var titleOf = function (u) { var c = state.convs.get(u); return c && c.name; };
    Object.keys(ENT_LABELS).forEach(function (k) {
      var rows = idx[k]; if (!rows || !rows.length) return;
      total += rows.length;
      var shown = rows.slice(0, 40);
      html.push('<h3>' + ENT_LABELS[k] + (rows.length > shown.length ? ' — top ' + shown.length + ' of ' + rows.length : '') + '</h3>');
      shown.forEach(function (r) {
        var cc = co[r.v];
        var coHtml = cc && cc.length ? cc.map(function (x) {
          return '<a href="#" class="entq" data-q="' + esc(x.v) + '">' + esc(x.v) + '</a>';
        }).join(', ') : '';
        html.push('<div class="entcard">' + entPopHtml(r, ENT_LABELS[k], axis, titleOf, { link: true, coHtml: coHtml }) + '</div>');
      });
    });
    if (!total) html.push('<p class="note">Nothing recurring yet — an entity must appear in at least 2 conversations.</p>');
    openPage('Entities', (scope ? scope.label + ' — ' + slist.length + ' of ' + state.convs.size : state.convs.size) +
      ' conversations · extracted locally, nothing uploaded', html.join(''));
    var as = $('#reader-body').querySelectorAll('a.entq');
    for (var i = 0; i < as.length; i++) (function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        closeReader();
        var q = '"' + a.getAttribute('data-q') + '"';
        $('#search').value = q;
        state.query = q; /* v1.47.1 — runSearch reads state.query, not the input (the rc-run pattern);
                            without this the box filled but the list stayed in browse mode */
        runSearch();
      });
    })(as[i]);
    /* the "most mentions in" conversation links open straight in the reader */
    var os = $('#reader-body').querySelectorAll('a.ep-open');
    for (var j = 0; j < os.length; j++) (function (a2) {
      a2.addEventListener('click', function (ev) {
        ev.preventDefault();
        var c = state.convs.get(a2.getAttribute('data-u'));
        if (c) openReader(c, 0);
      });
    })(os[j]);
  }

  /* top-bar "Suggest skills": rank the richest lenses, then render clickable proposals. Needs vectors. */
  function openSuggest() {
    if (!state.convs.size) { toast('Import an archive first — Suggest skills reads from it.', true); return; }
    semVecCount().then(function (n) {
      if (!n) { toast('Turn on Semantic search first (top bar) — Suggest skills ranks your topics by MEANING.', true); return; }
      showProgress('Finding the richest skills in your archive…', 8);
      semSuggest(function (m, p) { showProgress('Suggest skills — ' + m, p); }).then(function (props) {
        hideProgress();
        if (!props || !props.length) { toast('Not enough clustered material yet to suggest skills — try “Compile a skill” with a phrase.', true); return; }
        renderSuggest(props);
      }).catch(function (e) { hideProgress(); toast('Suggest skills failed: ' + ((e && e.message) || e), true); });
    });
  }
  function renderSuggest(props) {
    var head = '<p class="sg-intro">Ranked by how much of your archive backs each topic — thin ones are hidden so a skill is never padded with weak evidence. Each builds an installable <code>.skill</code> from your own words, locally. <span class="sg-tag seed">curated</span> = a known topic; <span class="sg-tag disc">discovered</span> = a cluster colloquary found in your own conversations. Counts are approximate, and a conversation can back several topics — topic counts overlap.</p>';
    var rows = props.map(function (p, i) {
      var sample = p.sample ? ' · e.g. “' + esc(String(p.sample).replace(/\s+/g, ' ').slice(0, 60)) + '”' : '';
      return '<div class="sg-item">' +
        '<div class="sg-h"><span class="sg-label">' + esc(p.label) + '</span>' +
        '<span class="sg-tag ' + (p.kind === 'seed' ? 'seed' : 'disc') + '">' + (p.kind === 'seed' ? 'curated' : 'discovered') + '</span></div>' +
        '<div class="sg-meta">' + sgApprox(p.convCount) + ' conversation' + (p.convCount === 1 ? '' : 's') + ' · ' + sgApprox(p.passages) + ' on-topic passage' + (p.passages === 1 ? '' : 's') + sample + '</div>' +
        '<button class="btn sg-compile" data-i="' + i + '">Compile this skill →</button>' +
        '</div>';
    }).join('');
    openPage('Suggest skills', props.length + ' topic' + (props.length === 1 ? '' : 's') + ' with enough material', head + '<div class="sg-list">' + rows + '</div>');
    state._suggest = props;
    var btns = $('#reader-body').querySelectorAll('.sg-compile');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        var p = state._suggest[+b.getAttribute('data-i')];
        if (!p) return;
        var nm = (window.prompt('First name for the skill (about-<name>-' + recipeSlug(p.label) + '):', 'me') || 'me').toLowerCase().replace(/[^a-z0-9]/g, '') || 'me';
        compileSkillFromRecipe({ label: p.label, lens: p.lens, intro: p.intro, useWhen: p.useWhen, kw: p.kw }, nm);
      });
    });
  }

  /* on-import / on-opt-in AUTO-SURFACE (2026-07-10, 2nd half of Eugen's "both" pick): once per session,
     after fresh vectors exist, quietly rank the archive and nudge the user toward Suggest skills — the
     onboarding moment. Runs the SAME semSuggest as the top-bar action (model is warm from the embed that
     just finished, so no download); shows a dismissible toast naming the top topics that TAPS OPEN the
     panel with the already-computed proposals (no recompute). Never triggers a model download on its own:
     if there are no vectors it does nothing, and semSuggest reuses the in-memory vectors. Fires at most
     once per page load so re-imports don't nag. */
  var suggestNudged = false;
  function suggestNudge() {
    if (suggestNudged) return;
    semVecCount().then(function (n) {
      if (!n) return;
      semSuggest(function () {}).then(function (props) {
        if (!props || !props.length || suggestNudged) return;
        suggestNudged = true;
        state._nudgeProps = props;
        var names = props.slice(0, 3).map(function (p) { return p.label; }).join(', ');
        /* delay so it never clobbers the import/ready toast that fired a moment earlier */
        setTimeout(function () {
          toast('Your archive can compile ' + props.length + ' skill' + (props.length === 1 ? '' : 's') + ' — ' + names + (props.length > 3 ? '…' : '') + '. Tap here, or open “Suggest skills” in the top bar.');
        }, 1400);
      }).catch(function () { /* a background nudge must never surface an error */ });
    });
  }

  /* incremental embed after an import that added/changed convs — only runs if the user opted in
     (vectors exist). Cached docs skip; only genuinely new text is embedded. */
  function semAfterImport() {
    semVecCount().then(function (n) {
      if (!n || semRun.busy) return;
      semRun.docs = null; semRun.vecs = null;
      /* v1.52.0 (advisor blocker): a chat re-import on iOS must not start an embed — read-only
         rebuild (new docs stay keyword-only until the next .cvec import); the nudge is skipped
         (semSuggest needs the model). Desktop path unchanged. */
      if (isIOS()) { semRebuildFromStore().then(function () { if (state.semOn) runSearch(); }).catch(function () {}); return; }
      semEmbedAll(function () {}).then(function () { if (state.semOn) runSearch(); suggestNudge(); }).catch(function () {});
    });
  }

  /* debug hooks (UI entry points are the top-bar button + the ≈ toggle since task 5/6):
     __semEmbed()          — extract + embed the whole archive (progress bar + [sem] logs)
     __semSearch('q', 10)  — console.table of top semantic hits
     __semInfo()           — device / model / in-memory + stored vector counts (async) */
  window.__semLoad = semLoad;
  window.__semEmbed = function () { return semEmbedAll(function (s) { console.log('[sem]', s); }); };
  window.__semSearch = function (q, n) { return semSearch(q, n).then(function (r) { console.table(r); return r; }); };
  window.__semInfo = function () {
    return semVecCount().then(function (n) {
      return { device: semDevice, modelReady: !!semExtractor, inMemory: semRun.docs ? semRun.docs.length : 0, stored: n };
    });
  };
  /* fire the on-import auto-surface nudge on demand (resets the once-per-session guard) — so a live
     smoke doesn't need a fresh import: run __suggestNudge() in the console, then tap the toast. */
  window.__suggestNudge = function () { suggestNudged = false; state._nudgeProps = null; return suggestNudge(); };

  /* ---------- audit fix 7 PILOT: __gemmaBench() (console-only, v1.43.0) ----------
     On-device separation + speed bench of EmbeddingGemma-300m q4 vs the live e5 — the decision gate
     for the model upgrade (audit §9: gemma measured 3–4× better separation in the sandbox; the open
     question is HIS Mac: speed on webgpu + no crash). GUARDED by construction: console-only (no UI,
     no default fetch), desktop-only, q4 (189 MB ≪ the fp32 that crashed WindowServer), batch 8,
     wasm retry, and it NEVER touches the e5 extractor, the vector store, or the search path —
     transformers 4.2 loads as an isolated module from /vendor/v4/. Assets are HEAD-checked first
     (the v1.33 lesson: ship a self-test, don't guess). */
  window.__gemmaBench = function (nDocs) {
    /* LIB GOTCHA (live-caught 2026-07-10): in transformers 4.x, dist/transformers.WEB.min.js imports the
       BARE specifier "onnxruntime-web/webgpu" (bundler-only → "Failed to resolve module specifier" in a
       browser); dist/transformers.min.js is the SELF-CONTAINED browser bundle (ort inlined, no bare
       imports — verified by scanning both files). The opposite of what the names suggest. */
    /* overlap guard (live-caught: re-running over a half-alive session → onnx "Session already
       started"/"Session mismatch"; also: don't use Semantic/Suggest while the bench runs) */
    if (window.__gemmaBusy) return Promise.reject(new Error('a bench is already running — hard-reload to reset, then run ONCE'));
    window.__gemmaBusy = true;
    var GB = { LIB: '/vendor/v4/transformers.min.js', WASM: '/vendor/v4/',
      MODEL: '/vendor/models/onnx-community/embeddinggemma-300m-ONNX',
      QP: 'task: search result | query: ', DP: 'title: none | text: ' };
    /* ort 1.26-dev fetches the ASYNCIFY wasm pair at runtime (live-caught 404 — jsep alone wasn't enough) */
    var files = [GB.LIB, GB.WASM + 'ort-wasm-simd-threaded.asyncify.mjs', GB.WASM + 'ort-wasm-simd-threaded.asyncify.wasm',
      GB.MODEL + '/config.json', GB.MODEL + '/tokenizer.json', GB.MODEL + '/onnx/model_q4.onnx', GB.MODEL + '/onnx/model_q4.onnx_data'];
    return Promise.all(files.map(function (u) {
      return fetch(u, { method: 'HEAD' }).then(function (r) {
        var mb = r.headers.get('content-length') ? ' ' + Math.round(r.headers.get('content-length') / 1048576) + 'MB' : '';
        return u.split('/').pop() + ': ' + r.status + mb;
      }, function () { return u.split('/').pop() + ': FETCH FAIL'; });
    })).then(function (chk) {
      console.log('[gemma] assets:\n  ' + chk.join('\n  '));
      if (chk.some(function (l) { return !/: 200/.test(l); })) throw new Error('assets missing on /vendor — fix the 404s above first');
      if (isIOS()) throw new Error('bench is desktop-only');
      return import(GB.LIB);
    }).then(function (T) {
      T.env.allowLocalModels = true; T.env.allowRemoteModels = false;
      T.env.backends.onnx.wasm.wasmPaths = GB.WASM;
      var dev = navigator.gpu ? 'webgpu' : 'wasm';
      console.log('[gemma] loading q4 on ' + dev + ' (~190 MB, one-time)…');
      var t0 = performance.now();
      function mk(device) { return T.pipeline('feature-extraction', GB.MODEL, { dtype: 'q4', device: device }); }
      return mk(dev).then(function (ex) { return { ex: ex, load: performance.now() - t0, dev: dev }; }, function (e) {
        console.warn('[gemma] ' + dev + ' failed (' + (e && e.message) + ') → retrying on wasm');
        var t1 = performance.now();
        return mk('wasm').then(function (ex) { return { ex: ex, load: performance.now() - t1, dev: 'wasm' }; });
      });
    }).then(function (ctx) {
      var docs = semExtractDocs(Array.from(state.convs.values()));
      if (!docs.length) throw new Error('no archive imported');
      var want = nDocs || 200, step = Math.max(1, Math.floor(docs.length / want));
      var sample = docs.filter(function (_, i) { return i % step === 0; }).slice(0, want).map(function (d) { return GB.DP + d.text; });
      var seeds = [];
      ['coding', 'design', 'writing'].forEach(function (k) { seeds.push(SKILL_RECIPES[k].lens); });
      SUGGEST_SEEDS.forEach(function (s) { seeds.push(s.lens); });
      var t0 = performance.now();
      return ctx.ex(seeds.map(function (s) { return GB.QP + s; }), { pooling: 'mean', normalize: true }).then(function (sv) {
        var seedVecs = seeds.map(function (_, i) { return sv[i].data; });
        var GD = seedVecs[0].length;
        var vecs = [], chain = Promise.resolve();
        for (var b = 0; b < sample.length; b += 8) (function (bat) {  /* batch 8 = the hard guard */
          chain = chain.then(function () {
            return ctx.ex(bat, { pooling: 'mean', normalize: true }).then(function (o) {
              for (var j = 0; j < bat.length; j++) vecs.push(o[j].data);
              if (vecs.length % 40 === 0) console.log('[gemma] embedded ' + vecs.length + '/' + sample.length);
            });
          });
        })(sample.slice(b, b + 8));
        return chain.then(function () {
          var secs = (performance.now() - t0) / 1000;
          /* MRL truncation (Matryoshka): first d dims, renormalized — EmbeddingGemma is MRL-trained
             (768/512/256/128), so a 256d slice is a VALID embedding, 1/3 the storage of 768d.
             Benched here on-device to decide the shipped dims (sandbox said 256d IQR is even WIDER). */
          function trunc(v, d) {
            var o = new Float32Array(d), n = 0, k;
            for (k = 0; k < d; k++) { o[k] = v[k]; n += v[k] * v[k]; }
            n = Math.sqrt(n) || 1;
            for (k = 0; k < d; k++) o[k] /= n;
            return o;
          }
          function metrics(sv2, dv2, d) {
            function dot(a, b2) { var s = 0; for (var k = 0; k < d; k++) s += a[k] * b2[k]; return s; }
            var mx = -2, nnSum = 0;
            for (var a2 = 0; a2 < sv2.length; a2++) {
              var best = -2;
              for (var c = 0; c < sv2.length; c++) { if (a2 === c) continue; var s2 = dot(sv2[a2], sv2[c]); if (s2 > best) best = s2; if (s2 > mx) mx = s2; }
              nnSum += best;
            }
            var all = [], margins = [];
            dv2.forEach(function (v) {
              var b1 = -2, b2 = -2;
              sv2.forEach(function (s3) { var sc = dot(s3, v); all.push(sc); if (sc > b1) { b2 = b1; b1 = sc; } else if (sc > b2) b2 = sc; });
              margins.push(b1 - b2);
            });
            all.sort(function (x, y) { return x - y; }); margins.sort(function (x, y) { return x - y; });
            var q = function (arr, p) { return arr[Math.floor(p * (arr.length - 1))]; };
            return { dims: d,
              seedConeMax: +mx.toFixed(3), seedConeMeanNN: +(nnSum / sv2.length).toFixed(3),
              docSeedIQR: +(q(all, 0.75) - q(all, 0.25)).toFixed(3),
              marginMedian: +q(margins, 0.5).toFixed(3),
              marginsUnder005: Math.round(100 * margins.filter(function (m) { return m < 0.005; }).length / margins.length) + '%' };
          }
          var full = metrics(seedVecs, vecs, GD);
          var MRL = 256;
          var m256 = metrics(seedVecs.map(function (v) { return trunc(v, MRL); }),
            vecs.map(function (v) { return trunc(v, MRL); }), MRL);
          var out = { device: ctx.dev, loadSec: +(ctx.load / 1000).toFixed(1),
            docs: vecs.length, docsPerSec: +(vecs.length / secs).toFixed(1),
            full: full, mrl256: m256 };
          console.table([
            Object.assign({ run: 'gemma-' + GD + 'd' }, full),
            Object.assign({ run: 'gemma-MRL-' + MRL + 'd' }, m256)
          ]);
          console.log('[gemma] device ' + out.device + ' · load ' + out.loadSec + 's · ' + out.docs + ' docs · ' + out.docsPerSec + ' docs/s');
          console.log('[gemma] e5 baseline (audit §9): cone max .917 / mean-NN .887 · doc·seed IQR .025 · margin median .005 / 47% under .005');
          console.log('[gemma] storage per vector vs e5-384d: ' + GD + 'd = 2× · MRL-' + MRL + 'd = 0.67× (.cvec ~33 MB not ~100 MB)');
          console.log('[gemma] full re-embed of ' + docs.length + ' docs at this rate ≈ ' + Math.round(docs.length / (vecs.length / secs) / 60) + ' min (one-time).');
          return out;
        });
      });
    }).then(function (out) { window.__gemmaBusy = false; return out; },
      function (e) { window.__gemmaBusy = false; console.error('[gemma] bench failed:', (e && e.message) || e); throw e; });
  };

  /* ---------- Wire up ---------- */
  function init() {
    openDB().then(function (d) {
      db = d;
      return Promise.all([loadAll(), getMeta('recentSearches'), getMeta('semOn'), getMeta('pinnedConvs'), getMeta('pinnedSearches'), getMeta('semModel')]);
    }).then(function (r) {
      r[0].forEach(function (c) { state.convs.set(c.uuid, c); });
      state.recent = r[1] || [];
      state.semOn = !!r[2];
      state.pins = r[3] || [];
      state.pinnedSearches = r[4] || [];
      /* v1.44.0: restore the chosen semantic model BEFORE any vector use. v1.52.0: phones too —
         the phone follows the last imported .cvec's model (importEmbeddings persists it); nothing
         heavy loads at init either way (v1.50.2 lazy arm). */
      if (r[5] && SEM_MODELS[r[5]]) semSetModel(r[5]);
      if (state.convs.size) {
        showProgress('Loading your archive…', 60);
        setTimeout(function () {
          ensureIndex().then(function () { hideProgress(); renderStats(); runSearch(); });
        }, 30);
      } else {
        renderStats(); runSearch();
      }
      /* the ≈ toggle exists only once vectors do (task 6); vectors load into memory only if the
         user left hybrid ON — otherwise page load stays byte-for-byte pre-v1.29 */
      semVecCount().then(function (n) {
        if (!n) {
          /* v1.50.0: hybrid was left ON but the active model has NO vectors. On iOS that means the
             browser evicted the vector DB under storage pressure (the archive DB can survive it).
             On desktop it can ALSO mean a model switch was interrupted before its first 512-vector
             flush (advisor catch — the semModel meta persists before the embed) — so the desktop
             copy names both causes honestly. The ≈ chip used to just vanish silently. */
          if (state.semOn) {
            state.semOn = false; setMeta('semOn', false);
            /* v1.52.0 (advisor should-fix): same smarts as the semFailed fallback — if the active
               model's vectors are gone but e5's are still here, offer the one-tap way back. */
            if (isIOS() && SEM.KEY !== 'e5') {
              semVecCount(SEM_MODELS.e5.MODEL_KEY).then(function (n5) {
                if (n5) {
                  toast('No ' + SEM.LABEL + ' vectors on this phone — but your e5 vectors are still here. TAP THIS MESSAGE to switch semantic search back to e5.', true);
                  state._toastAction = semBackToE5; /* armed AFTER the toast (stale-action rule) */
                } else {
                  toast('Your semantic vectors were removed by the browser to free storage. Re-import your .cvec file (Import embeddings) — or re-export one from your computer.', true);
                }
              });
              return;
            }
            toast(isIOS()
              ? 'Your semantic vectors were removed by the browser to free storage. Re-import your .cvec file (Import embeddings) — or re-export one from your computer.'
              : 'No semantic vectors found for ' + SEM.LABEL + ' — the browser freed storage, or a model switch didn’t finish. Run Semantic search to re-embed (it resumes), or import a matching .cvec.', true);
          }
          return;
        }
        $('#sem-toggle').hidden = false;
        syncSemToggle();
        /* v1.50.2 (live-caught): on iOS the boot-time vector preload (~50 MB for 32k vectors, on
           top of archive + index) crash-looped Safari into "a problem repeatedly occurred" — the
           one failure mode that blocks the site itself. Phones now defer the load to the first
           ≈-active search (semAugment arms it with progress). Desktop preload unchanged. */
        if (state.semOn && !isIOS()) semEnsureDocs();
      });
    });

    /* ≈ toggle (task 6): persisted; hidden until vectors exist */
    function syncSemToggle() {
      var t = $('#sem-toggle');
      t.setAttribute('aria-pressed', state.semOn ? 'true' : 'false');
      t.title = state.semOn
        ? 'Hybrid search ON — keyword + meaning-based matches, re-ranked together. Click for keyword only.'
        : 'Meaning-based matches OFF — pure keyword search. Click to fold semantic matches back in.';
    }
    $('#sem-toggle').addEventListener('click', function () {
      state.semOn = !state.semOn;
      setMeta('semOn', state.semOn);
      syncSemToggle();
      if (state.semOn) {
        semDisabled = false; /* a manual opt-in retries a previously-failed load */
        /* pay the model-init cost NOW, visibly — not in slices between keystrokes (freeze fix) */
        showProgress('Semantic: loading…', 20);
        Promise.all([
          semEnsureDocs(),
          semLoad(function (s) { showProgress('Semantic: ' + s, 60); })
        ]).then(
          function (r) { hideProgress(); if (r[0]) runSearch(); },
          function (err) { hideProgress(); semFailed(err); syncSemToggle(); }
        );
      } else runSearch();
    });

    $('#file-input').addEventListener('change', function (e) {
      if (e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });

    ['dragover', 'dragenter'].forEach(function (ev) {
      document.body.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.body.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.remove('drag'); });
    });
    document.body.addEventListener('drop', function (e) {
      /* a dropped FOLDER is a Claude Code / Cowork session import; a file is the export flow */
      var fsEntries = [];
      var items = e.dataTransfer.items || [];
      for (var i = 0; i < items.length; i++) {
        var en = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
        if (en) fsEntries.push(en);
      }
      if (fsEntries.some(function (en) { return en.isDirectory; })) {
        showProgress('Reading folder…', 1);
        collectEntries(fsEntries, function (out) { hideProgress(); importSessionEntries(out); });
        return;
      }
      if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
    });

    $('#dir-input').addEventListener('change', function (e) {
      if (e.target.files.length) importSessionFileList(e.target.files);
      e.target.value = '';
    });

    $('#vec-input').addEventListener('change', function (e) {
      if (e.target.files.length) importEmbeddings(e.target.files[0]);
      e.target.value = '';
    });

    /* Top feature bar — replaces the ⋯ overflow menu, surfacing Stats/Coach/me.skill directly.
       Data-driven: add or reorder a <button class="tnav" data-act="…"> in #topnav and map it here. */
    function toggleTopnav(open) {
      var w = $('#topwrap');
      if (open === undefined) open = !w.classList.contains('open');
      w.classList.toggle('open', open);
      $('#topbar').setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    /* Save the vector store to a .cvec file (desktop) → AirDrop/cloud → import on the phone. */
    function downloadEmbeddings() {
      semVecCount().then(function (n) {
        if (!n) { toast('No embeddings yet — run “Semantic search” first (best on a desktop) to create them.', true); return; }
        showProgress('Preparing embeddings…', 40);
        semExportBlob().then(function (r) {
          hideProgress();
          var a = document.createElement('a');
          a.href = URL.createObjectURL(r.blob);
          a.download = 'colloquary-embeddings-' + SEM.KEY + '-' + new Date().toISOString().slice(0, 10) + '.cvec'; /* content+date naming rule; model in the name since v1.44.0 */
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
          toast(r.count + ' embeddings saved (' + (r.blob.size / 1048576).toFixed(0) + ' MB). On your phone: open colloquary → import your archive → “Import embeddings”.');
        }).catch(function (e) { hideProgress(); toast('Export failed: ' + ((e && e.message) || e), true); });
      });
    }
    /* Load a .cvec on the phone: write the vectors straight into IDB (no model, no 32k-doc embed) →
       semantic search works; only a live QUERY loads the model. Archive must be imported first so the
       content-hash keys line up (native archive import is byte-preserving, so hashes match). */
    function importEmbeddings(file) {
      if (!state.convs.size) { toast('Import your archive first, then the embeddings.', true); return; }
      showProgress('Reading embeddings…', 20);
      file.arrayBuffer().then(function (buf) {
        /* v1.52.0 — GEMMA-ON-PHONE: the phone FOLLOWS the .cvec you import. A .cvec for another
           REGISTERED model offers an explicit switch (confirm names both models + the model-download
           size + the way back) instead of erroring. Each model's vectors are store-keyed separately,
           so switching loses nothing and importing an e5 .cvec later switches back the same way. */
        if (isIOS()) {
          var h0;
          try { h0 = cvecHeader(buf); } catch (e0) { hideProgress(); toast(e0.message, true); return; }
          if (h0.mk !== SEM.MODEL_KEY || h0.dims !== SEM.DIMS) {
            var oKey = Object.keys(SEM_MODELS).filter(function (k2) { return SEM_MODELS[k2].MODEL_KEY === h0.mk && SEM_MODELS[k2].DIMS === h0.dims; })[0];
            if (oKey) {
              var to = SEM_MODELS[oKey];
              hideProgress();
              /* v1.52.3 — VERDICT (two live rounds on Eugen's iPhone, 2026-07-12): Gemma does NOT
                 run on iOS. Round 1, plain q4: wasm EP lacks GatherBlockQuantized (clean ERROR 9).
                 Round 2, the no-gather export: downloads fine, then session creation HANGS
                 indefinitely on single-thread wasm (no rejection — the manual Semantic-model escape
                 is the way out). Copy states the known outcome up front; the mechanism stays for
                 future runtimes. */
              if (!confirm('These embeddings are for ' + to.LABEL + ' — this phone is on ' + SEM.LABEL + '.\n\n' +
                (to.NATIVE_DIMS ? 'HEADS-UP: on iPhones today the Gemma model does NOT finish loading — e5 is the working choice on phones. You can still switch and try; the way back to e5 is one tap (top bar → Semantic model).\n\n' : '') +
                'Switch this phone to ' + to.LABEL + ' and import them?\n\n• the first semantic search then downloads its model once (' + (to.NATIVE_DIMS ? '~195 MB' : '~118 MB') + ')\n• importing a .cvec for the other model switches back anytime — nothing is lost, each model’s vectors are kept separately')) return;
              if (!semSetModel(oKey)) { toast('Could not switch the model right now (an embedding run is busy?) — try again.', true); return; }
              setMeta('semModel', oKey);
              showProgress('Reading embeddings…', 20);
            } /* unknown model → fall through, semImportBuffer names it honestly */
          }
        }
        var pairs;
        try { pairs = semImportBuffer(buf, isIOS()); } catch (e) { hideProgress(); toast((e && e.message) || 'Bad embeddings file', true); return; }
        var put = function (i) {
          if (i >= pairs.length) return Promise.resolve();
          showProgress('Importing embeddings… ' + Math.min(i + 2000, pairs.length) + '/' + pairs.length, i / pairs.length * 100);
          return semVecPut(pairs.slice(i, i + 2000)).then(function () { return put(i + 2000); });
        };
        put(0).then(function () {
          semRun.docs = null; semRun.vecs = null;
          return semRebuildFromStore(); /* rebuild in-memory vectors from IDB — never embeds, no model */
        }).then(function (have) {
          hideProgress();
          reqPersist(); /* v1.50.0: 50 MB of vectors just landed — ask the browser not to evict them */
          state.semOn = true; setMeta('semOn', true);
          $('#sem-toggle').hidden = false; syncSemToggle();
          runSearch();
          /* v1.50.1: the import turns ≈ ON itself (two lines up) — the old copy said "turn on
             ≈ semantic", telling the user to do something already done (live-caught confusion).
             v1.52.0: model-aware — after a gemma import the size is ~190 MB, and naming the model
             keeps the "which import am I on?" question answered (Eugen's ask). */
          toast(have + ' of your messages now have embeddings — “≈ semantic” is now ON (' + SEM.LABEL + '). Just search; the first search downloads the model once (' + (SEM.NATIVE_DIMS ? '~190 MB' : '~118 MB') + ').');
        }).catch(function (e) { hideProgress(); toast('Import failed: ' + ((e && e.message) || e), true); });
      }, function () { hideProgress(); toast('Could not read the file', true); });
    }

    var TOPNAV_ACTS = {
      stats: openStats, coach: openTokenCoach, entities: openEntities, meskill: makeMeSkill, help: openHelp,
      /* custom lens (compiler): type a topic → semScan selects on-topic passages by meaning →
         extractive brief. Needs the semantic vectors (opt-in). Preview + Save-PDF like the summaries. */
      compile: function () {
        if (!state.convs.size) { toast('Import an archive first — Compile distills from it.', true); return; }
        if (!SEM.CAL) { toast('Compile is calibrated for e5 — switch the semantic model back to e5 (top bar → Semantic model). Gemma calibration is the next update.', true); return; }
        semVecCount().then(function (n) {
          if (!n) { toast('Turn on Semantic search first (top bar) — Compile selects passages by MEANING.', true); return; }
          var phrase = (window.prompt('Compile a topic — a phrase to distill by meaning (e.g. "how I handle deploys", "my debugging style"):', '') || '').trim();
          if (!phrase) return;
          /* persistent progress bar the whole time — the model load (query embed) + a 35k-vector scan can
             take several seconds, and a peek-toast vanishes before the output (Eugen 2026-07-10). */
          var label = 'Compiling “' + phrase + '”';
          showProgress(label + ' — preparing…', 2);
          semEnsureDocs().then(function () {
            showProgress(label + ' — loading your vectors…', 5);
            /* the bar width TRACKS the real model-download % (Eugen 2026-07-10: it must match the shown
               number and read full at 100% right before the answer opens). Cached model → no % reported,
               so it sits low, then the scan fills it to 100%. */
            return semLoad(function (m) {
              var mt = /(\d+)\s*%/.exec(m);
              showProgress(label + ' — ' + m, mt ? Math.max(6, +mt[1]) : 6);
            });
          }).then(function () {
            showProgress(label + ' — scanning your archive…', 100);
            return semScan(phrase, 200);
          }).then(function (hits) {
            /* CALIBRATED 2026-07-10 (Eugen): e5 scores are compressed into a narrow high band with NO cliff
               (debugging: best 0.863, 40th 0.847, 41st 0.847), so a score threshold can't split on/off-topic
               and the old margin cutoff always hit the cap. Shape instead by an absolute FLOOR (reject a
               nonsense phrase's weak top) + a PER-CONVERSATION cap (so one dense chat can't dominate → more
               breadth) + a total cap. The count now varies with how many DISTINCT convs are near the phrase
               (narrow topic → fewer passages). */
            var FLOOR = SEM.GATE.lensFloor, PERCONV = 3, MAX = 24; /* v1.44.1: per-model (e5 0.75 · gemma 0.45, above junk tops 0.44) */
            var perConv = {}, passages = [];
            for (var i = 0; i < hits.length && passages.length < MAX; i++) {
              var h = hits[i];
              if (h.score < FLOOR) break; /* sorted desc → nothing better remains below the floor */
              var c = state.convs.get(h.convUuid), doc = c && c.docs[h.idx];
              if (!c || !doc) continue;
              var seen = perConv[h.convUuid] || 0;
              if (seen >= PERCONV) continue; /* keep it broad, not deep-in-one-chat */
              perConv[h.convUuid] = seen + 1;
              passages.push({ s: doc.s, ty: doc.ty, fn: doc.fn, date: doc.d || h.date, conv: c.name, source: c.source || 'claude', text: doc.t, score: h.score });
            }
            hideProgress();
            if (!passages.length) { toast('No passages related to “' + phrase + '” — try a broader phrase.', true); return; }
            var coverage = 'Semantic ranking — the passages closest in meaning to “' + phrase + '” (not an exhaustive filter; ≤' + PERCONV + ' per conversation for breadth).';
            previewSummary('Compiled — ' + phrase, buildLensSummary(phrase, passages, coverage, ''));
            toast('Compiled ' + passages.length + ' passage' + (passages.length === 1 ? '' : 's') + ' on “' + phrase + '” — your words only. Save PDF to keep it.');
          }).catch(function (e) { hideProgress(); toast('Compile failed: ' + ((e && e.message) || e), true); });
        });
      },
      /* compile a preset (or custom) SKILL from a semantic lens: scope the shared me.skill detectors to
         the on-topic conversations and render a recipe-framed .skill. Needs the semantic vectors. */
      compileskill: function () {
        if (!state.convs.size) { toast('Import an archive first — Compile-a-skill distills from it.', true); return; }
        semVecCount().then(function (n) {
          if (!n) { toast('Turn on Semantic search first (top bar) — Compile-a-skill selects the topic by MEANING.', true); return; }
          var raw = (window.prompt('Compile a skill — a preset (coding, design, writing), any phrase, or merge 2–3 with "+" (e.g. coding + design):', 'coding') || '').trim();
          if (!raw) return;
          /* v1.46.0 — "a + b" compiles ONE merged skill: union of the lenses, each side gated honestly */
          var parts = raw.split('+').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 3).map(function (s) {
            var b = SKILL_RECIPES[s.toLowerCase()];
            return b ? { label: b.label, lens: b.lens, kw: b.kw, intro: b.intro, useWhen: b.useWhen }
              : { label: s.slice(0, 40), lens: s, intro: 'How this user approaches “' + s + '”, distilled from the on-topic conversations.', useWhen: 'this topic comes up' };
          });
          if (!parts.length) return;
          var base = parts.length > 1 ? mergeRecipes(parts) : parts[0];
          var nm = (window.prompt('First name for the skill (about-<name>-' + recipeSlug(base.label) + '):', 'me') || 'me').toLowerCase().replace(/[^a-z0-9]/g, '') || 'me';
          /* distill via the shared core (also used by Suggest skills); custom phrases pass no kw so it
             derives one from the phrase words inside compileSkillFromRecipe. */
          compileSkillFromRecipe({ label: base.label, lens: base.lens, intro: base.intro, useWhen: base.useWhen, kw: base.kw, parts: base.parts }, nm);
        });
      },
      suggest: openSuggest,
      semdownload: downloadEmbeddings,
      semimport: function () { $('#vec-input').click(); },
      /* v1.44.0 — semantic model switcher: e5 (default, calibrated) ⇄ EmbeddingGemma MRL-256d
         (2026-07-10 on-device bench: doc·seed IQR 0.114 vs e5 0.025 — much sharper meaning
         separation; ~86 min one-time re-embed, resumable by construction: the content-addressed
         store checkpoints every 512 vectors, so a closed tab resumes where it left off).
         SEARCH-ONLY until v1.44.1 recalibrates the Compile/Suggest gates in gemma space. */
      semmodel: function () {
        if (!state.convs.size) { toast('Import an archive first.', true); return; }
        if (isIOS()) {
          /* v1.52.0: manual escape hatch — after a gemma import (or a crash the page couldn't
             catch), the way back must not require a new .cvec. Synchronous confirm — no toast
             action, no staleness. */
          if (SEM.KEY !== 'e5') {
            semVecCount(SEM_MODELS.e5.MODEL_KEY).then(function (n5) {
              if (n5 && confirm('This phone is on ' + SEM.LABEL + '. Switch semantic search back to e5-small?\n\nIts vectors are still stored here — the switch is instant.')) { semBackToE5(); return; }
              toast('This phone follows the .cvec you import — currently on ' + SEM.LABEL + '. To change models, import a .cvec made with the other model (the filename carries it: “-e5-” or “-gemma256-”).', true);
            });
            return;
          }
          toast('This phone follows the .cvec you import — currently on ' + SEM.LABEL + '. To change models, import a .cvec made with the other model (the filename carries it: “-e5-” or “-gemma256-”).', true);
          return;
        }
        if (semRun.busy) { toast('An embedding run is in progress — let it finish (or close and reopen the tab), then switch.', true); return; }
        var toKey = SEM.KEY === 'e5' ? 'gemma256' : 'e5';
        var to = SEM_MODELS[toKey];
        var msg = toKey === 'gemma256'
          ? 'Switch semantic search to ' + to.LABEL + '?\n\n• much sharper meaning-matching (benchmarked on this machine)\n• one-time: downloads the model (~190 MB, self-hosted on colloquary.com) and re-embeds your archive (roughly 1–1.5 h; resumable — if you close the tab it continues where it stopped)\n• your current e5 vectors are KEPT — switching back is instant\n• search AND Compile / Suggest run on Gemma (gates calibrated on real vectors)\n\nStart?'
          : 'Switch back to ' + to.LABEL + '?\n\nYour e5 vectors are still stored — this is instant, nothing re-embeds. Compile / Suggest work again immediately.';
        if (!confirm(msg)) return;
        if (!semSetModel(toKey)) return;
        setMeta('semModel', toKey);
        semEmbedAll(function () {}).then(function (r) {
          reqPersist(); /* v1.50.0 advisor catch: the THIRD heavy vector write — protect it too */
          state.semOn = true; setMeta('semOn', true);
          $('#sem-toggle').hidden = false; syncSemToggle();
          toast('Semantic model: ' + SEM.LABEL + ' — ' + r.vectors + ' of ' + r.docs + ' vectors ready.' + (SEM.CAL ? '' : ' Compile / Suggest stay on e5 until the calibration update.'));
          runSearch();
        }).catch(function (e) { toast('Model switch failed: ' + ((e && e.message) || e), true); });
      },
      /* diagnostic (2026-07-09): semantic won't load on Eugen's iPhone and the failure isn't catchable
         (no reject → no toast). HEAD-check the model files + report device caps so ONE screenshot says
         whether it's a missing q8 file (404), no SharedArrayBuffer (threading), or low memory. */
      semtest: function () {
        /* v1.52.2: check the files THIS device would load (iOS gemma = the no-gather export) */
        var mroot = (isIOS() && SEM.MODEL_IOS) ? SEM.MODEL_IOS : SEM.MODEL;
        var base = mroot + '/onnx/';
        var checks = SEM.NATIVE_DIMS ? [ /* gemma: q4 model + weights, asyncify ort pair (v4 lib) */
          ['q4 model', base + 'model_q4.onnx'],
          ['q4 weights', base + ((isIOS() && SEM.MODEL_IOS) ? 'model_no_gather_q4.onnx_data' : 'model_q4.onnx_data')],
          ['tokenizer', mroot + '/tokenizer.json'],
          ['ort wasm', SEM.WASM_DIR + 'ort-wasm-simd-threaded.asyncify.wasm'],
          ['transformers.js', SEM.LIB]
        ] : [
          ['q8 model (mobile)', base + 'model_quantized.onnx'],
          ['fp16 model (desktop)', base + 'model_fp16.onnx'],
          ['tokenizer', mroot + '/tokenizer.json'],
          ['ort wasm', SEM.WASM_DIR + 'ort-wasm-simd-threaded.jsep.wasm'],
          ['transformers.js', SEM.LIB]
        ];
        var env0 = 'model: ' + SEM.LABEL + '\n';
        var env = 'WebGPU: ' + (!!navigator.gpu) +
          '\ncrossOriginIsolated: ' + (self.crossOriginIsolated === true) +
          '\nSharedArrayBuffer: ' + (typeof SharedArrayBuffer !== 'undefined') +
          '\ndeviceMemory: ' + (navigator.deviceMemory || '?') + ' GB';
        /* v1.52.3: iOS deleted the vector DB twice on 2026-07-12 — show whether the browser
           granted persistent storage (reqPersist asks; iOS rarely grants outside home-screen apps) */
        var pP = (navigator.storage && navigator.storage.persisted)
          ? navigator.storage.persisted().catch(function () { return '?'; })
          : Promise.resolve('?');
        Promise.all(checks.map(function (c) {
          return fetch(c[1], { method: 'HEAD' }).then(function (r) {
            var mb = (+r.headers.get('content-length') || 0) / 1048576;
            return c[0] + ': HTTP ' + r.status + (mb ? ' — ' + mb.toFixed(1) + ' MB' : '');
          }, function (e) { return c[0] + ': FETCH FAILED (' + ((e && e.message) || e) + ')'; });
        })).then(function (lines) {
          pP.then(function (p) {
            alert('colloquary semantic self-test\n\n' + env0 + env + '\npersistent storage: ' + p + '\n\n' + lines.join('\n'));
          });
        });
      },
      /* opt-in semantic setup (task 5): explicit consent for the big self-hosted download; until
         clicked the app never fetches a byte of model. Re-running later = incremental update. */
      semantic: function () {
        if (!state.convs.size) { toast('Import an archive first — semantic search needs your conversations.'); return; }
        /* v1.50.0: embedding an archive is NOT viable on a phone (hours of single-thread wasm, and
           Safari kills the tab) — the old path let the user start it anyway and read as a freeze
           (Eugen's iPhone, 2026-07-12). Error prevention over error messages: on iOS this action
           TEACHES the working flow instead of starting the impossible one. */
        if (isIOS()) {
          /* v1.50.1 (live-caught): once a .cvec IS imported, this action must not re-lecture — its
             job is done; just make sure hybrid is on and say so. The teaching alert is only for the
             no-vectors state. */
          semVecCount().then(function (n) {
            if (n) {
              state.semOn = true; setMeta('semOn', true);
              $('#sem-toggle').hidden = false; syncSemToggle();
              runSearch(); /* v1.50.2: vectors load lazily at the first ≈ search (memory discipline on iOS) */
              toast('Semantic is ready on this phone — ' + n.toLocaleString() + ' vectors imported (' + SEM.LABEL + ') and “≈ semantic” is ON. Just search. To update after new chats, import a fresh .cvec.');
            } else {
              alert('Embedding your archive needs a computer — on this phone it would take hours and Safari may stop the tab.\n\nOn your computer:\n1. open colloquary and import your archive\n2. run Semantic search (embeds once)\n3. Download embeddings — one .cvec file\n4. send the file to this phone (AirDrop) and use Import embeddings here\n\nOnly the vectors travel — nothing leaves your devices.');
            }
          });
          return;
        }
        semVecCount().then(function (n) {
          var msg = n
            ? 'Semantic vectors exist for this archive. Update them now?\n\nOnly new or changed messages since the last run are embedded (the model downloads again only if your browser evicted it).'
            : 'Semantic search finds messages by MEANING — paraphrases, other languages, vague memories — and folds them into normal keyword results.\n\nOne-time setup:\n• downloads the AI model from colloquary.com (' + (SEM.NATIVE_DIMS ? '~190 MB' : '~120 MB on CPU, ~240 MB with GPU') + ') — self-hosted, no third parties\n• embeds your archive locally (progress shown; resumable)\n\nYour conversations never leave this browser. Start?';
          if (!confirm(msg)) return;
          /* v1.50.0: paint BEFORE the synchronous 30k-message doc pass (it froze the page with no
             feedback), and surface semEmbedAll's status — the model download used to report into a
             no-op ("progress shown" was promised and not kept). One-shot foreground setTimeout is
             fine — the no-setTimeout rule guards the EMBED LOOP against background throttling. */
          showProgress('Semantic: preparing your archive…', 10);
          setTimeout(function () {
            semEmbedAll(function (s) {
              if (/^(embedded |READY)/.test(s)) return; /* the embed loop paints its own richer line */
              var mt = /(\d+)\s*%/.exec(s);
              showProgress('Semantic: ' + s, mt ? Math.max(15, +mt[1]) : 15);
            }).then(function (r) {
              reqPersist(); /* vectors just landed — ask the browser not to evict them */
              state.semOn = true;
              setMeta('semOn', true);
              $('#sem-toggle').hidden = false;
              syncSemToggle();
              toast('Semantic search ready — ' + r.vectors + ' pieces of your archive embedded. The ≈ toggle by the search bar switches hybrid on/off.');
              runSearch();
              suggestNudge(); /* just embedded the whole archive → the onboarding moment to surface Suggest skills */
            }).catch(function (e) {
              hideProgress(); /* the busy-reject path doesn't hide it itself */
              toast('Semantic setup failed: ' + ((e && e.message) || e), true);
            });
          }, 50);
        });
      },
      importexport: function () { $('#file-input').click(); },
      'import': function () { $('#dir-input').click(); },
      download: downloadArchive,
      clear: function () {
        if (!confirm('Delete the local archive from this browser? Your export files and claude.ai are not affected.')) return;
        clearAll().then(function () {
          /* v1.29: semantic vectors are DERIVED from the private text — clearing the archive must
             clear them too (privacy invariant), plus the toggle and its persisted state */
          semRun.docs = null; semRun.vecs = null; semVdbP = null;
          try { indexedDB.deleteDatabase('chatalog-vectors'); } catch (e) { /* best effort */ }
          state.semOn = false; setMeta('semOn', false);
          $('#sem-toggle').hidden = true;
          renderStats(); runSearch(); toast('Local archive cleared (semantic vectors included).');
        });
      }
    };
    /* v1.45.0 — footer: about / privacy / how-to-use links + version */
    var fa = $('#f-about'), fp = $('#f-privacy'), fh = $('#f-help'), fq = $('#f-faq'), fv = $('#f-ver');
    if (fa) fa.addEventListener('click', function (e) { e.preventDefault(); openAbout(); });
    if (fp) fp.addEventListener('click', function (e) { e.preventDefault(); openPrivacy(); });
    if (fh) fh.addEventListener('click', function (e) { e.preventDefault(); openHelp(); });
    if (fq) fq.addEventListener('click', function (e) { e.preventDefault(); openFaq(); });
    if (fv) fv.textContent = 'v' + APP_VERSION;
    /* v1.45.4 — the same links under the header tagline (Eugen: reachable without scrolling past the archive) */
    var hln = [['#h-about', openAbout], ['#h-faq', openFaq], ['#h-privacy', openPrivacy], ['#h-help', openHelp]];
    hln.forEach(function (p) {
      var a = $(p[0]);
      if (a) a.addEventListener('click', function (e) { e.preventDefault(); p[1](); });
    });

    $('#topbar').addEventListener('click', function () { toggleTopnav(); });
    /* v1.45.6/.7 — the whole header opens the menu too (big tap target on mobile); the logo (home) and
       the header links keep their own actions. stopPropagation is REQUIRED: the document-level
       close-on-outside-click handler would otherwise close the menu on the same bubbling event
       (v1.45.6 live bug: header click appeared to do nothing, desktop + mobile). */
    $('#page-head').addEventListener('click', function (e) {
      if (e.target.closest && (e.target.closest('#home-logo') || e.target.closest('.hdr-links'))) return;
      e.stopPropagation();
      $('#recent-pop').classList.remove('open'); /* keep the outside-click behavior the doc handler would have done */
      toggleTopnav();
    });
    $('#topbar').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTopnav(); }
    });
    $('#topnav').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button.tnav') : null;
      if (!b) return;
      toggleTopnav(false);
      var fn = TOPNAV_ACTS[b.getAttribute('data-act')];
      if (fn) fn();
    });
    /* every toast is click-to-dismiss (v1.40.2, Eugen) — no waiting out the ~7 s timeout. The auto-surface
       nudge is the one actionable toast: it parks its ranked proposals on state._nudgeProps, so a tap OPENS
       the Suggest-skills panel with those exact proposals (no recompute) instead of just dismissing. */
    $('#toast').addEventListener('click', function () {
      clearTimeout(toastTimer);
      if (state._nudgeProps) {
        var p = state._nudgeProps; state._nudgeProps = null;
        this.className = '';
        renderSuggest(p);
        return;
      }
      if (state._toastAction) { /* v1.45.2 — generic one-shot tap action (e.g. "also save the plain .md") */
        var fn = state._toastAction; state._toastAction = null;
        this.className = '';
        fn();
        return;
      }
      this.className = ''; /* plain toast → dismiss immediately */
    });

    /* audit §4 (2026-07-07): on a big code-heavy archive one search can cost ~2 s of main-thread
       time (measured live: ~1.9 s at 34.9k docs, result-count independent — MiniSearch prefix+fuzzy
       over identifier vocabulary). A fixed 120 ms debounce let TYPING queue several such searches
       back-to-back (measured: a burst froze the tab 45 s+). Pace keystroke searches by the MEASURED
       cost of the previous one — small archives keep the snappy 120 ms, big ones self-throttle. */
    var debounce = null, lastSearchMs = 0;
    var runSearchTimed = function () {
      var t0 = Date.now();
      try { runSearch(); } finally { lastSearchMs = Date.now() - t0; }
    };
    $('#search').addEventListener('input', function (e) {
      state.query = e.target.value;
      syncClear();
      clearTimeout(debounce);
      debounce = setTimeout(runSearchTimed, pvClamp(Math.round(lastSearchMs * 1.2), 120, 700));
    });
    /* the wordmark acts as a home button (v1.27.2): reset to the default browse view */
    $('#home-logo').addEventListener('click', function () {
      closeReader();
      $('#search').value = '';
      state.query = '';
      state.srcTabs = [];
      syncClear();
      markActiveTab();
      runSearch();
      window.scrollTo(0, 0);
    });
    $('#demo-btn').addEventListener('click', installDemo);
    $('#demo-clear').addEventListener('click', clearDemo);
    $('#search-clear').addEventListener('click', function () {
      $('#search').value = '';
      state.query = '';
      syncClear();
      runSearch();
    });

    $('#sort').addEventListener('change', function (e) {
      state.sort = e.target.value;
      runSearch();
    });

    $('#sender').addEventListener('change', function (e) {
      state.sender = e.target.value;
      runSearch();
    });

    $('#dossier-btn').addEventListener('click', function () {
      if (!state.dossier) return;
      var md = buildDossier(state.dossier.convs, state.dossier.label);
      var slug = state.dossier.label.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'archive';
      var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = 'colloquary dossier ' + slug + ' ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + '.' + pad(d.getMinutes()) + '.md';
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('Dossier saved — ' + state.dossier.convs.length + ' conversation' + (state.dossier.convs.length > 1 ? 's' : '') + ' in one .md (attach it to any AI chat as context)');
    });

    $('#summary-btn').addEventListener('click', function () {
      if (!state.dossier) return;
      previewSummary('Summary — ' + state.dossier.label, buildSetSummary(state.dossier.convs, state.dossier.label));
      toast('Extractive summary of ' + state.dossier.convs.length + ' conversation' + (state.dossier.convs.length === 1 ? '' : 's') + ' — your words only. Save PDF to keep it.');
    });

    $('#reader-summary-btn').addEventListener('click', function () {
      var c = state.readerConv;
      if (!c || !c.uuid) return; /* not a real conversation (e.g. a generated preview) */
      previewSummary('Summary — ' + c.name, buildConvSummary(c));
      toast('Extractive summary — your words only, nothing generated. Save PDF to keep it.');
    });

    $('#src-tabs').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button.stab') : null;
      if (!b) return;
      var ds = b.getAttribute('data-src');
      if (ds === '__pinned') { state.pinView = !state.pinView; state.srcTabs = []; } /* toggle pinned-only view */
      else if (ds === '') { state.pinView = false; state.srcTabs = []; } /* "all" clears */
      else {
        state.pinView = false;
        var at = state.srcTabs.indexOf(ds);
        if (at >= 0) state.srcTabs.splice(at, 1); else state.srcTabs.push(ds);
      }
      markActiveTab();
      runSearch();
    });

    /* Stats / Token coach / Make me.skill / How to use now live in the top bar (TOPNAV_ACTS above). */

    /* browsers use document.title as the default PDF filename — give it a dated, non-overwriting one */
    $('#reader-print').addEventListener('click', function () {
      var old = document.title;
      /* EXPORT-NAMING RULE (2026-07-10): every exported document is named by its CONTENT + DATE.
         Browsers take the default PDF filename from document.title, so build it from the reader content. */
      var c = state.readerConv;
      var clean = function (s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim(); };
      var nm = clean(($('#reader-title').textContent) || (c && c.name) || 'conversation').slice(0, 80);
      var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
      var todayStr = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      if (c && c.uuid) { /* a real conversation → "<chat> - <date> - <type>[ - <model>]" */
        var date = (c.created_at || c.updated_at || '').slice(0, 10) || todayStr;
        var type = c.source || 'claude';
        var model = c.model ? clean(c.model) : ''; /* lights up automatically once model-in-modal ships */
        document.title = ['colloquary', nm, date, type, model].filter(Boolean).join(' - ');
      } else { /* generated preview (summary / me.skill, uuid '') or a static page → content + today */
        document.title = 'colloquary - ' + nm + ' - ' + todayStr;
      }
      /* iOS Safari: window.print() does NOT block, and the PDF filename is read from document.title when the
         preview renders (moments later). NEVER revert synchronously — that was the bug that let the PDF take
         the site <title>. Restore on afterprint (desktop) with a delayed fallback for iOS. */
      var restore = function () { document.title = old; };
      window.addEventListener('afterprint', function h() { window.removeEventListener('afterprint', h); restore(); });
      window.print();
      setTimeout(restore, 8000);
    });

    /* links inside static pages (Stats records) reopen the reader on that conversation */
    $('#reader-body').addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a.readlink') : null;
      if (!a) return;
      e.preventDefault();
      openReader(a.getAttribute('data-conv'), parseInt(a.getAttribute('data-doc'), 10) || 0);
    });

    /* Clear data now lives in the top bar (#topnav data-act="clear"). */

    document.querySelector('.hints').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button.op') : null;
      if (!b) return;
      var ins = b.getAttribute('data-ins');
      var caret = ins.indexOf('|');
      ins = ins.replace('|', '');
      var el = $('#search');
      var base = el.value && !/\s$/.test(el.value) ? el.value + ' ' : el.value;
      el.value = base + ins;
      var pos = base.length + (caret >= 0 ? caret : ins.length);
      el.focus();
      el.setSelectionRange(pos, pos);
      state.query = el.value;
      runSearch();
    });

    /* v1.30.1 example-question chips (router discoverability): fill the box with a real question.
       A data-tmpl chip ("how many hours on ") fills + focuses the caret so the user types their
       topic (the input handler runs it); a complete-question chip fills + runs immediately. */
    $('#asks').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button.ask') : null;
      if (!b) return;
      var q = b.getAttribute('data-q'), el = $('#search');
      el.value = q;
      state.query = q;
      el.focus();
      el.setSelectionRange(q.length, q.length);
      if (!b.getAttribute('data-tmpl')) runSearch(); /* template chips wait for the user's topic */
    });

    $('#recent-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      $('#recent-pop').classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('#recent-wrap')) $('#recent-pop').classList.remove('open');
      if (!e.target.closest || !e.target.closest('#topwrap')) toggleTopnav(false);
    });
    $('#recent-pop').addEventListener('click', function (e) {
      var pin = e.target.closest ? e.target.closest('.rc-pin') : null;
      if (pin) { e.stopPropagation(); togglePinSearch(pin.getAttribute('data-pinq')); return; } /* pin/unpin, keep the popover open */
      var clr = e.target.closest ? e.target.closest('#recent-clear') : null;
      if (clr) {
        state.recent = [];
        setMeta('recentSearches', []);
        renderRecent();
        if (!(state.pinnedSearches || []).length) $('#recent-pop').classList.remove('open'); /* stay open if pins remain */
        return;
      }
      var run = e.target.closest ? e.target.closest('.rc-run') : null;
      if (!run) return;
      $('#search').value = run.getAttribute('data-q');
      state.query = run.getAttribute('data-q');
      $('#recent-pop').classList.remove('open');
      runSearch();
    });

    $('#results').addEventListener('click', function (e) {
      var pn = e.target.closest ? e.target.closest('button.pin') : null;
      if (pn) { e.preventDefault(); togglePin(pn.getAttribute('data-pin')); return; }
      var pf = e.target.closest ? e.target.closest('a.pfold') : null;
      if (pf) {
        e.preventDefault();
        var fq = 'folder:"' + pf.getAttribute('data-folder') + '"';
        $('#search').value = fq;
        state.query = fq;
        runSearch();
        return;
      }
      var f = e.target.closest ? e.target.closest('a.filelink') : null;
      if (f) {
        e.preventDefault();
        openReader(f.getAttribute('data-conv'), 0, { showFiles: true });
        return;
      }
      var a = e.target.closest ? e.target.closest('a.snippet, a.readlink') : null;
      if (!a) return;
      e.preventDefault();
      openReader(a.getAttribute('data-conv'), parseInt(a.getAttribute('data-doc'), 10) || 0);
    });

    /* v1.30 query-router answer strip: dismiss (learn "not analytics" for this exact question, then
       just search it) or jump to the full Stats page scoped to the matched set (setDossier already
       pointed viewScope at those conversations during render). */
    $('#answer').addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('.ans-x')) { routeDismissed[state.query.trim().toLowerCase()] = 1; runSearch(); return; }
      if (e.target.closest('.ans-stats')) { openStats(state.route ? state.route.period : null); }
    });

    /* download a text attachment (doc index in the reader conv) — shared by the message bar ⬇ and the files-view ⬇ */
    function downloadDoc(i) {
      var c = state.readerConv;
      var doc = c && c.docs[i];
      if (!doc) return;
      /* name the download after its conversation: "<chat> - <date> - <original>.<ext>" (Eugen's ask) */
      var clean = function (s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim(); };
      var orig = clean(doc.fn || 'attachment.txt'), ext = '.txt', dot = orig.lastIndexOf('.');
      if (dot > 0 && /^[a-z0-9]{1,6}$/i.test(orig.slice(dot + 1))) { ext = orig.slice(dot); orig = orig.slice(0, dot); }
      var cn = clean(c.name).slice(0, 60);
      var dt = (doc.d || c.updated_at || c.created_at || '').slice(0, 10);
      var name = [cn, dt, orig].filter(Boolean).join(' - ') + ext;
      var blob = new Blob([doc.t], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }

    /* copy the file name of a "name only" chip (the export kept no text — the name is all there is) */
    function copyName(chip) {
      var name = chip.getAttribute('data-copy') || '';
      var pill = chip.querySelector('.fno');
      var flash = function (msg) {
        if (!pill) return;
        if (pill.__orig == null) pill.__orig = pill.textContent;
        pill.textContent = msg;
        clearTimeout(pill.__t);
        pill.__t = setTimeout(function () { pill.textContent = pill.__orig; pill.__orig = null; }, 1100);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(name).then(function () { flash('copied!'); }, function () { flash('press ⌘C'); });
      } else {
        try { var ta = document.createElement('textarea'); ta.value = name; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); flash('copied!'); }
        catch (err) { flash('press ⌘C'); }
      }
    }
    $('#reader-files').addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a.fno-open')) return; /* let the ↗ open claude.ai */
      var cp = e.target.closest ? e.target.closest('.fchip.copyable') : null;
      if (cp && cp.getAttribute('data-copy') != null) { copyName(cp); return; }
      var dl = e.target.closest ? e.target.closest('button.fc-dl') : null;
      if (dl) { downloadDoc(parseInt(dl.getAttribute('data-doc'), 10)); return; }
      var b = e.target.closest ? e.target.closest('button.fc-open') : null;
      if (!b) return;
      $('#reader-panel').classList.remove('files-mode');
      updateFilesBtn($('#reader-files-btn').getAttribute('data-n') || '');
      var t = document.getElementById('rmsg-' + b.getAttribute('data-doc'));
      if (t) { t.classList.remove('collapsed'); t.scrollIntoView({ block: 'start' }); t.classList.add('hit'); }
    });

    $('#reader-body').addEventListener('click', function (e) {
      var dl = e.target.closest ? e.target.closest('button.att-dl') : null;
      if (dl) { downloadDoc(parseInt(dl.getAttribute('data-doc'), 10)); return; }
      var h = e.target.closest ? e.target.closest('button.att-head') : null;
      if (!h) return;
      h.closest('.msg').classList.toggle('collapsed');
    });

    $('#reader-files-btn').addEventListener('click', function () {
      $('#reader-panel').classList.toggle('files-mode');
      updateFilesBtn($('#reader-files-btn').getAttribute('data-n') || '');
    });

    $('#reader-pin').addEventListener('click', function () { if (state.readerConv) togglePin(state.readerConv.uuid); });

    /* find-in-conversation wiring */
    $('#reader-find-btn').addEventListener('click', function () {
      if ($('#reader-find').hidden) findOpen(); else findClose();
    });
    $('#find-input').addEventListener('input', function () { findRun(this.value); });
    $('#find-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); findClose(); }
    });
    $('#find-prev').addEventListener('click', function () { findStep(-1); $('#find-input').focus(); });
    $('#find-next').addEventListener('click', function () { findStep(1); $('#find-input').focus(); });
    $('#find-close').addEventListener('click', findClose);

    $('#reader-close').addEventListener('click', closeReader);
    $('#reader').addEventListener('click', function (e) { if (e.target === $('#reader')) closeReader(); });
    document.addEventListener('keydown', function (e) {
      var open = $('#reader').classList.contains('open');
      if (open && (e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); findOpen(); return; } /* ⌘/Ctrl+F = in-reader find */
      if (e.key === 'Escape') {
        if (open && !$('#reader-find').hidden) { findClose(); return; } /* Esc closes find first, then the reader */
        closeReader();
      }
    });

    /* Copy button on each rendered code block (reader body). pre.textContent = the raw code
       (tags stripped, entities decoded); the button lives outside the <pre> so it never copies itself. */
    $('#reader-body').addEventListener('click', function (e) {
      var cc = e.target.closest ? e.target.closest('.codecopy') : null;
      if (!cc) return;
      e.preventDefault();
      var pre = cc.parentNode && cc.parentNode.querySelector('.codeblock');
      var text = pre ? pre.textContent : '';
      var flash = function (msg) { cc.textContent = msg; setTimeout(function () { cc.textContent = 'Copy'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { flash('Copied'); }, function () { flash('Press ⌘/Ctrl+C'); });
      } else {
        try { var r = document.createRange(); r.selectNodeContents(pre); var s = window.getSelection();
          s.removeAllRanges(); s.addRange(r); flash('Selected'); } catch (err) { flash('Copy failed'); }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
