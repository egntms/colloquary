# colloquary

**Search your Claude & ChatGPT chat history — 100% in your browser. Nothing is uploaded, ever.**

[colloquary.com](https://colloquary.com) · a single HTML file · no server, no accounts, no analytics

Your AI chat export is a zip full of JSON you can't read. colloquary turns it into a searchable,
readable archive — and then into something more useful than an archive: **installable skills
compiled from how you actually work.**

Everything runs locally. Your conversations are parsed in a web worker, indexed in memory, and
stored in IndexedDB on your own machine. There is no backend to send them to.

---

## Verify the privacy claim yourself

Don't take my word for it — this is the whole reason the code is readable:

1. Open [colloquary.com](https://colloquary.com) and **View Source**. The file you are served *is*
   the source: unminified, comments intact. It's the same `chatalog.html` in this repo.
2. Open DevTools → Network, load your export, search, compile a skill. **Zero requests.**
3. Or just go offline. Turn off your wifi and use it — everything still works. (The one exception is
   opt-in semantic search, which downloads an embedding model *once*; see below.)

A privacy tool you can't read is just a promise. This one you can check in about a minute.

## What it does

- **Browse & full-text search** every conversation — including attached files — with mail-style
  operators (`from:me`, `"exact phrase"`, `source:chatgpt`, date filters).
- **Read** conversations in-app, with find-in-conversation and attachment recovery.
- **Ask questions about your own history** — "how many chats about X?", "how much time did I spend
  on Y?" — answered by a local query router, not an LLM.
- **Stats & entities** — your activity over time, and the domains / IPs / repos / paths that make up
  your technical footprint, each with a timeline.
- **Token coach** — what your conversations actually cost in context: where the long chats are, which
  ones bloat, and where you'd have been better off starting fresh.
- **Semantic search (opt-in, desktop)** — on-device embeddings (E5 or EmbeddingGemma via
  transformers.js / ONNX Runtime Web) fold meaning-matches into keyword results. The model downloads
  once from this site's own webroot; after that it's local too. Desktop-only, deliberately: iOS won't
  grant a tab enough memory to hold the model session and the vectors alongside the archive, so it
  reloads the page mid-search. Phones get keyword search over every word, browse, reader, stats and
  entities — the compile surface needs the model, so it lives on the desktop too.
- **Compile skills** — the payoff. Point a lens at your archive ("coding", "design", or any phrase)
  and it extracts your actual patterns — corrections, rituals, decisions, vocabulary — into an
  installable `.skill` (or plain Markdown, which works with any assistant). Every line is pulled
  verbatim from your own messages; nothing is generated. Thin evidence produces an honest refusal,
  never a padded skill.

Supported inputs: **Claude** data export (`conversations.json`), **ChatGPT** export, **Claude Code /
Cowork** session files, and colloquary's own archive format.

## Run it

**The easy way:** go to [colloquary.com](https://colloquary.com) and drop your export on the page.

**The paranoid way** (recommended, honestly): download `chatalog.html` from this repo, open it from
your own filesystem with no network, and drop your export on that. It's one file. It works offline.
Nothing about it needs a server.

Get your export: Claude → Settings → Privacy → Export data. ChatGPT → Settings → Data controls →
Export data. Both arrive by email as a zip.

## Build

```sh
npm i                 # fflate + minisearch, the only two dependencies
python3 assemble.py   # -> chatalog.html (~570 KB, everything inlined)
```

`assemble.py` inlines the vendored libraries, the worker and the app into `shell.html`. That's the
entire build system. Bundle size is treated as a feature.

## Tests

```sh
node test_query.js    # and test_router, test_semantic, test_entities, test_summary, ...
```

13 suites run standalone (no data needed) — they extract the real functions out of `app.js` and
`worker.js` rather than reimplementing them. `test_core.js` is a search bench that needs your own
`conversations.json`.

## How it works

- **One file.** `shell.html` (markup + CSS) + `app.js` + `worker.js` + two vendored libraries
  ([MiniSearch](https://github.com/lucaong/minisearch), [fflate](https://github.com/101arrowz/fflate)),
  concatenated by `assemble.py`. No framework, no build chain, no bundler.
- **Import** happens in a worker: unzip → normalize (each platform has its own adapter) → upsert
  into IndexedDB with a schema version. Re-importing is incremental and additive.
- **Search** is MiniSearch over an in-memory index built at load.
- **Semantic** vectors live in a separate IndexedDB store, addressed by model, so you can switch
  models without losing anything. They can be exported as a `.cvec` file and imported on another
  computer, which skips re-embedding there. (That file used to carry vectors to a phone; the phone
  could hold them but not run the query model, so semantic is desktop-only as of v1.58.0.)
- **Skills** are compiled by scoping the archive with a semantic lens, then running extractive
  detectors over the scoped conversations.

## Privacy

No network calls after page load. No cookies. No analytics. No third parties. No upload path exists
in the code — not disabled, *absent*. The server that hosts colloquary.com serves one static file
and keeps standard access logs; it never sees your data because your data never leaves your browser.

The only outbound request the app can ever make is the one-time embedding-model download, if you
explicitly opt into semantic search.

## License

[AGPL-3.0](LICENSE). Fork it, study it, run it, change it. If you deploy a modified version as a
service, publish your changes. The name **colloquary** and its wordmark are not covered by the
licence.

## Not affiliated

Not affiliated with, endorsed by, or connected to Anthropic or OpenAI. "Claude" and "ChatGPT" are
their respective owners' trademarks. This is an independent tool that reads the exports they give
you.
