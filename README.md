# Perplexity Conversation Exporter (patk1002 fork)

> **Fork notice (2026-09-08).** Rate-limit and large-thread reliability pass.
>
> **What changed:**
>
> 1. **Three-tier rate limiting** (`src/rateLimitStrategy.ts`, new) — checks
>    `RateLimit-Remaining`/`RateLimit-Reset` (or legacy `X-RateLimit-*`)
>    proactively, then an actual `Retry-After` header, falling back to an
>    adaptive AIMD-style delay plus a fixed 30/60/120/240/300/300/300s
>    schedule only when neither header is present. Framework-agnostic and
>    reusable in other projects.
> 2. **PAGE_LIMIT 25 → 100** (default; overridable via `--page-limit`) —
>    fewer round trips per thread means fewer opportunities to hit a 429,
>    which was the actual root cause of large-thread failures.
> 3. **Crash-resilient staging** — each page's entries are appended to
>    `<outputDir>/.staging/<slug>.partial.jsonl` as they arrive, so an
>    interrupted run resumes from the last complete page instead of
>    refetching a thread from scratch.
> 4. **Quick/deferred pass scheduling** — a thread still fetching after
>    `--defer-after-pages` (default 3) pages is parked and resumed in a
>    second pass, so a handful of very large threads can't block many
>    small ones from finishing.
> 5. **New flags**: `-v/--verbose` (opt-in detailed logging), `-u/--url`
>    (process one thread, skipping the full library scan), `--page-limit`,
>    `--defer-after-pages`, `--rate-limit-retries`.
> 6. **Pagination root-cause fix** — `rawFetchPageOnce` previously paginated
>    via a raw incrementing `offset` parameter, which the server silently
>    ignores past the first page; the real mechanism is a `cursor` query
>    parameter (a continuation token from the previous response's
>    `next_cursor` field), confirmed by diffing our request against the
>    live product's own DevTools network capture. Every thread beyond
>    ~100 entries was previously stuck re-fetching the same fixed window
>    forever, disguised as genuine growth (`has_next_page: true`) — a
>    684-entry-looking thread turned out to be 199 entries once fixed.
>    This, not rate limiting alone, was the actual cause of the worst
>    large-thread failures described in point 2 above.
> 7. **Streaming JSON output** — the final `.json` write and the JSONL
>    staging-file read are both now streamed line-by-line/item-by-item
>    instead of using a single `JSON.stringify()`/`readFileSync()` call,
>    avoiding V8's hard ~536.8M-character string-length limit on very
>    large threads.
> 8. **Broadened retryable statuses** — 502/504 added alongside 429/503;
>    raw network-level exceptions (not just HTTP status codes) are now
>    also retried.
> 9. **Stats files relocated** to `<outputDir>/stat-files/` instead of the
>    project root.

> **Fork notice (2026-09-05).** This fork builds on
> [`osedlacek/perplexport`](https://github.com/osedlacek/perplexport) (itself
> a fork of the original [`leonid-shevtsov/perplexport`](https://github.com/leonid-shevtsov/perplexport)),
> adding incremental re-export support and Central-time-stamped filenames.
>
> **What changed (vs `osedlacek/main`):**
>
> 1. **Filename format** (`src/exportLibrary.ts`) — filenames now start with
>    a `YYYYMMDDHHMMSS` prefix derived from each thread's
>    `entry_updated_datetime`, converted from UTC to `America/Chicago` local
>    time via `Intl.DateTimeFormat` (correctly handles the CST/CDT
>    transition with no manual offset math). Previously, filenames ended
>    with a plain `YYYY-MM-DD` suffix based on creation date, which didn't
>    reflect edits and didn't sort chronologically by recency.
> 2. **Incremental re-export** (`src/types.ts`, `src/listConversations.ts`,
>    `src/utils.ts`, `src/exportLibrary.ts`) — `done.json` changed from a
>    flat array of processed URLs to a map keyed by thread slug, storing
>    each thread's last-seen `updatedAt` and exported filename. Since the
>    library-listing GraphQL query already returns `updatedAt` per thread,
>    conversations you've continued to update after their first export are
>    now detected automatically and re-exported — without needing to open
>    every thread just to check for changes.
> 3. **Stale-file cleanup** (`src/exportLibrary.ts`) — when a previously
>    exported thread is re-exported under a new timestamp, the old
>    `.json`/`.md` pair is deleted automatically instead of accumulating
>    duplicate copies of the same conversation.
> 4. **Known limitation** — a small, consistent subset of threads may return
>    HTTP 403 on a per-thread fetch while the library listing and every
>    other thread succeed. Root cause not yet confirmed; suspected causes
>    include archived/private threads or a stale per-thread access scope.
>    These are safely skipped and retried on the next run without blocking
>    the rest of the export.

> **Fork notice (2026-05-03).** This fork brings the original
> [`leonid-shevtsov/perplexport`](https://github.com/leonid-shevtsov/perplexport)
> back to working order against the current Perplexity site (May 2026). The
> upstream stopped working sometime after July 2025 because Perplexity changed
> several DOM selectors, the login flow, and the per-thread API pagination
> defaults.
>
> **What changed (vs upstream `main`):**
>
> 1. **Login** (`src/login.ts`) — multi-selector cookie banner with EN/CS
>    variants; verifies login via `/api/auth/session` poll instead of waiting
>    for `#ask-input` (which is rendered to logged-out users too); explicit
>    instructions to use the 6-digit code, not the magic link in the email
>    (the magic link logs in your _regular_ browser, not the Puppeteer one).
> 2. **Library enumeration** (`src/listConversations.ts`) — observe and replay
>    the `/rest/thread/list_ask_threads` POST with paginated `offset`. The old
>    DOM-scrape approach only saw the ~20 threads in the sidebar; this gets
>    the full archive.
> 3. **Per-thread fetch** (`src/ConversationSaver.ts`) — direct API call to
>    `/rest/thread/<uuid>?limit=1000` with offset pagination via
>    `has_next_page`. The original captured the SPA's natural request which
>    used `limit=10`, silently truncating any thread with >10 turns. Also ~10×
>    faster (no per-thread page navigation).
> 4. **Resilience** (`src/exportLibrary.ts`) — try/catch per conversation with
>    page-recreation recovery on `detached Frame` / `Target closed` /
>    `Session closed` errors. Cookies persist on the browser context, so no
>    re-login is needed during recovery.
>
> Original README below — most of it still applies.

---

This tool automatically exports your Perplexity conversations as JSON and markdown files. Built with TypeScript and Puppeteer.

It's raw but functional. You will need to log in using your email code. Sometimes there are issues with stability (as to be expected with browser automation).

Your credentials and session are not stored, so from one side it's all secure, from the other requires manual attention to run.

I do not use the built-in export functionality (it's rate limited and the output is quite sparse), but render the conversation from its data. The data itself is stored as JSON and could be considered a complete backup of the conversation.

## Prerequisites

See [PREREQUISITES.md](./PREREQUISITES.md) for required software and a one-shot install script.

## Usage

```
Usage: npx perplexport -e <email> [options]

Export Perplexity conversations as markdown files

Options:
  -o, --output <directory>  Output directory for conversations (default: ".")
  -d, --done-file <file>    Done file location (tracks which URLs have been downloaded before) (default: "done.json")
  -e, --email <email>       Perplexity email
  -h, --help                display help for command
  -v/--verbose              opt-in detailed logging,
  -u/--url`                 process one thread, skipping the full library scan,
  --page-limit,
  --defer-after-pages,
  --rate-limit-retries
```

The script will:

1. Log in to your Perplexity account (Only login with email is currently supported)
2. You will need to provide the login code sent to your email
3. Navigate to your conversation library
4. Store every conversation's data in JSON
5. Render conversation into Markdown
6. Save the files in the specified output directory (defaults to `./conversations`)

Conversations you've since updated in Perplexity will be automatically re-exported on your next run — the old `.json`/`.md` pair for that thread is replaced, not duplicated.

### Troubleshooting

- If the browser doesn't open at all, or opens and closes instantly, try `npx puppeteer browsers install chrome`.
- Puppeteer doesn't like to be ran from a global installation, so perhaps try cloning the project and running it this way.
- A handful of threads may consistently fail with `HTTP 403` while everything else succeeds. This is a known limitation (see fork notice above) — they're skipped safely and retried on the next run.

## Development setup

```bash
git clone https://github.com/patk1002/perplexport.git
cd perplexport
npm install
npm run build
node dist/cli.js -e <your-perplexity-email> -o ./conversations -d done.json
```

---

Original (c) 2025 [Leonid Shevtsov](https://leonid.shevtsov.me) — MIT.
Fork (c) 2026 Ondřej Sedláček — MIT.
Fork (c) 2026 Pat Kelly — MIT.
