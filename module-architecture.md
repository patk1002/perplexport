# Module Architecture

Data and call flow between the TypeScript modules in the export pipeline.

```mermaid
flowchart TD
    CLI["cli.ts<br/>Parses -o / -d / -v / -u / -e flags,<br/>plus --page-limit / --defer-after-pages /<br/>--rate-limit-retries, into ExportLibraryOptions"]

    EL["exportLibrary.ts<br/>Orchestrator: launches Puppeteer,<br/>authenticates, fetches thread list,<br/>splits quick vs deferred pass,<br/>frame-error recovery, writes<br/>per-pass RunStats"]

    CS["ConversationSaver.ts<br/>Per-thread engine: startThread /<br/>fetchNextPage / finalizeThread,<br/>JSONL staging, stale-file cleanup,<br/>assembles final .md/.json,<br/>updates done.json"]

    RLS["rateLimitStrategy.ts<br/>Pure three-tier backoff utility:<br/>decideThrottle, AdaptiveDelay,<br/>fetchWithTieredRetry, RateLimitError<br/>(no imports from other modules)"]

    BROWSER[["Puppeteer browser/page<br/>(external)"]]
    API[["Perplexity /rest/* API<br/>(external, over network)"]]

    STAGING[("Filesystem:<br/>outputDir/.staging/&lt;slug&gt;.partial.jsonl")]
    OUTPUT[("Filesystem:<br/>outputDir/*.md, *.json")]
    DONE[("Filesystem:<br/>done.json")]
    STATS[("Filesystem:<br/>done.json.stats-quick-&lt;ts&gt;.json<br/>done.json.stats-deferred-&lt;ts&gt;.json<br/>done.json.stats-single-&lt;ts&gt;.json")]

    CLI -->|"options: outputDir, doneFilePath,<br/>email, verbose, url?, pageLimit,<br/>deferAfterPages, rateLimitRetries"| EL

    EL -->|"new ConversationSaver(page, options)<br/>+ saver.initialize()"| CS
    EL -->|"saver.startThread(conversation)<br/>→ ThreadFetchState"| CS
    EL -->|"saver.fetchNextPage(state)<br/>→ ThreadFetchState (bounded, resumable)"| CS
    EL -->|"saver.finalizeThread(state)<br/>→ ThreadResult"| CS
    EL -->|"saver.setPage(newPage)<br/>on frame-error recovery (preserves<br/>accumulated stats + done.json state)"| CS
    CS -.->|"saver.pageFetchRecords,<br/>saver.failedSlugs,<br/>saver.safetyCapSlugs<br/>(read after each pass)"| EL

    EL --> BROWSER
    CS --> BROWSER
    BROWSER --> API

    CS -->|"fetchWithTieredRetry(rawFetch, parseBody, ctx)<br/>→ {data, tier} or throws RateLimitError"| RLS
    RLS -.->|"resolved page JSON + which tier fired<br/>or thrown error"| CS

    CS --> STAGING
    CS --> OUTPUT
    CS --> DONE
    EL --> STATS

    style RLS fill:#eef,stroke:#557
    style CLI fill:#efe,stroke:#575
```

## Module responsibilities

| Module | Responsibility | Depends on |
|---|---|---|
| `cli.ts` | Argument parsing only; no business logic. | `exportLibrary.ts` |
| `exportLibrary.ts` | Orchestrates the run: browser lifecycle, thread list (or single `-u/--url` thread), quick/deferred pass split, frame-error recovery, per-pass `RunStats` computation and write. | `ConversationSaver.ts` |
| `ConversationSaver.ts` | Resumable per-thread fetch primitives (`startThread` / `fetchNextPage` / `finalizeThread`), JSONL staging checkpoints, stale-file cleanup, final output write, `done.json` updates, timing/failure/safety-cap tracking. | `rateLimitStrategy.ts` |
| `rateLimitStrategy.ts` | Three-tier backoff decision (`RateLimit-*`/`X-RateLimit-*` header → `Retry-After` → adaptive-AIMD-plus-fixed-schedule fallback), isolated retry loop. | *(none — pure utility)* |

## Key data flows

- **Options** (`outputDir`, `doneFilePath`, `email`, `verbose`, `url`, `pageLimit`, `deferAfterPages`, `rateLimitRetries`) flow one-way from `cli.ts` → `exportLibrary.ts` → `ConversationSaver` constructor. The last three tune the constants the initial design session flagged as "worth revisiting once you see real data," without requiring a rebuild to change them.
- **Conversations** flow from `exportLibrary.ts` (either the full library scan, or a single synthesized `Conversation` in `-u/--url` mode) into `saver.startThread()`. Each thread's `ThreadFetchState` is threaded through repeated `fetchNextPage()` calls, capped at `deferAfterPages` on the first pass; anything not yet `isDone()` is parked in a `deferred` array and resumed to completion in pass 2 — no re-fetching of already-fetched pages.
- **Fetch functions** flow into `fetchWithTieredRetry()`; a resolved page payload plus which tier decided the delay flows back out, or a thrown `RateLimitError` after all retries are exhausted. `rateLimitStrategy.ts` never touches Puppeteer or the filesystem directly, keeping it independently testable and portable to other projects (e.g. LIMIT's shopping/trading automation).
- **Durability**: `fetchNextPage()` appends each page's entries to `<outputDir>/.staging/<slug>.partial.jsonl` (one JSON object per line) *before* returning, in addition to the in-memory `ThreadFetchState.entries`. `startThread()` checks for a matching staging file and resumes from its last complete line (a truncated trailing line from a mid-write crash is safely discarded) instead of starting a thread over from page 0. The staging file is deleted only after the permanent `.json`/`.md` pair and `done.json` are safely written.
- **Recovery**: on a detached-Frame / Target-closed / Session-closed / protocolTimeout error, `exportLibrary.ts` recreates the Puppeteer page and calls `saver.setPage(newPage)` — it does **not** construct a new `ConversationSaver` — so accumulated `pageFetchRecords`, `failedSlugs`, `safetyCapSlugs`, and the in-memory `done.json` state all survive the recovery.

## Filename standards

- PascalCase for files exporting a single class, camelCase for function/utility modules.
