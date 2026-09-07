## Module Architecture

Data and call flow between the TypeScript modules in the export pipeline.

```mermaid
flowchart TD
    CLI["cli.ts<br/>Parses -o / -d / -v / -e flags<br/>into ExportLibraryOptions"]

    EL["exportLibrary.ts<br/>Orchestrator: launches Puppeteer,<br/>authenticates, fetches thread list,<br/>splits quick vs deferred pass,<br/>computes RunStats"]

    CS["ConversationSaver.ts<br/>Per-thread engine: fetches pages,<br/>writes staging checkpoints,<br/>deletes stale files, assembles<br/>final .md/.json, updates done.json"]

    RLS["rateLimitStrategy.ts<br/>Pure backoff/retry utility:<br/>computeBackoffMs, parseRetryAfter,<br/>RateLimitError, withRateLimitRetry<br/>(no imports from other modules)"]

    BROWSER[["Puppeteer browser/page<br/>(external)"]]
    API[["Perplexity /rest/* API<br/>(external, over network)"]]

    STAGING[("Filesystem:<br/>outputDir/.staging/&lt;slug&gt;/page-N.json")]
    OUTPUT[("Filesystem:<br/>outputDir/*.md, *.json")]
    DONE[("Filesystem:<br/>done.json")]
    STATS[("Filesystem:<br/>done.json.stats-&lt;timestamp&gt;.json")]

    CLI -->|"options: outputDir, doneFilePath,<br/>email, verbose"| EL

    EL -->|"new ConversationSaver(page,<br/>outputDir, doneFilePath, verbose)"| CS
    EL -->|"saver.estimatePageCount(slug)<br/>→ number"| CS
    EL -->|"saver.exportThread(slug)<br/>→ ThreadResult"| CS
    CS -.->|"saver.pageFetchRecords,<br/>saver.failedSlugs (read after run)"| EL

    EL --> BROWSER
    CS --> BROWSER
    BROWSER --> API

    CS -->|"withRateLimitRetry(fetchFn, opts)<br/>→ result or throws RateLimitError"| RLS
    RLS -.->|"resolved page JSON<br/>or thrown error"| CS

    CS --> STAGING
    CS --> OUTPUT
    CS --> DONE
    EL --> STATS

    style RLS fill:#eef,stroke:#557
    style CLI fill:#efe,stroke:#575
```

### Module responsibilities

| Module | Responsibility | Depends on |
|---|---|---|
| `cli.ts` | Argument parsing only; no business logic. | `exportLibrary.ts` |
| `exportLibrary.ts` | Orchestrates the run: browser lifecycle, thread list, pass 1/pass 2 split, final `RunStats` computation and write. | `ConversationSaver.ts` |
| `ConversationSaver.ts` | Per-thread fetch loop, staging checkpoints, stale-file cleanup, final output write, `done.json` updates, timing/failure tracking. | `rateLimitStrategy.ts` |
| `rateLimitStrategy.ts` | Backoff schedule (30/60/120/240/300/300/300s), `Retry-After` header parsing, isolated retry loop. | *(none — pure utility)* |

### Key data flows

- **Options** (`outputDir`, `doneFilePath`, `email`, `verbose`) flow one-way from `cli.ts` → `exportLibrary.ts` → `ConversationSaver` constructor.
- **Slugs** flow from `exportLibrary.ts` into `saver.exportThread()`; a `ThreadResult` and accumulated `pageFetchRecords`/`failedSlugs` flow back out for the end-of-run stats file.
- **Fetch functions** flow into `withRateLimitRetry()`; a resolved page payload or a thrown `RateLimitError` flows back out. `rateLimitStrategy.ts` never touches Puppeteer or the filesystem directly, keeping it independently testable.

### Filename standards

- PascalCase for files exporting a single class, camelCase for function/utility modules.
