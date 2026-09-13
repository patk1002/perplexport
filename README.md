# Perplexity Conversation Exporter (patk1002 fork)

This tool exports your Perplexity conversations as JSON and Markdown files, built with TypeScript and Puppeteer. It logs in with your email code, walks your entire conversation library (not just what's visible in the sidebar), and renders each conversation from its underlying data rather than using Perplexity's own built-in export (which is rate-limited and produces sparse output). The JSON output can be considered a complete backup of each conversation.

Your credentials and session are never stored — secure on one hand, but requiring manual login each run on the other. As with any browser automation, occasional stability issues are to be expected.

## Usage

```
node dist/cli.js -e <email> [options]

Export Perplexity conversations as JSON + Markdown files

Options:
  -e, --email <email>       Perplexity email
  -d, --done-file <file>    Done file location (tracks which URLs have been downloaded before) (default: "done.json")
  -o, --output <dir>        Output directory for exported conversations (default: "./conversations")
  -u, --url <url>           Process exactly one thread URL, skipping the full library scan (done.json is still read and updated for that thread)
  -v, --verbose             Enable verbose logging (browser console output, per-page fetch timing, rate-limit tier decisions) (default: false)
  --page-limit <n>          Entries fetched per API page (default: 100)
  --defer-after-pages <n>   Pages after which a still-fetching thread is parked for a second pass, so it can't block smaller threads (default: 3)
  --rate-limit-retries <n>  Max retries for a page fetch that keeps getting rate-limited (default: 7)
  -h, --help                display help for command
```

The script will:

1. Log in to your Perplexity account (only login with email is currently supported)
2. Prompt you for the login code sent to your email
3. Navigate to your conversation library
4. Store every conversation's data as JSON
5. Render each conversation into Markdown
6. Save the files in the specified output directory (defaults to `./conversations`)

Conversations you've since updated in Perplexity are automatically re-exported on your next run — the old `.json`/`.md` pair for that thread is replaced, not duplicated.

## Prerequisites

See [PREREQUISITES.md](./PREREQUISITES.md) for required software and a one-shot install script.

## Development setup

```bash
git clone https://github.com/patk1002/perplexport.git
cd perplexport
npm install
npm run build
node dist/cli.js -e <your-perplexity-email> -o ./conversations -d done.json
```

## Troubleshooting

- If the browser doesn't open at all, or opens and closes instantly, try `npx puppeteer browsers install chrome`.
- Puppeteer doesn't like to be run from a global installation — try cloning the project and running it locally instead.
- A small, consistent subset of threads may return HTTP 403 on their per-thread fetch — the same threads fail identically across multiple fresh logins, while the library listing and every other thread succeed. If you open one of these threads directly in a regular browser, it typically shows "This answer is private... Request Access," even though you are the account's own owner, and requesting access never resolves anything (there's no separate owner to approve it). This matches a reported Perplexity backend bug where the index that serves thread content gets out of sync with the index that determines ownership, effectively locking an account out of its own thread. There's no client-side fix: these threads are safely skipped, their partial progress is preserved in `.staging/`, and the rest of the export continues unaffected. Retry occasionally in case Perplexity resolves the desync server-side, or contact Perplexity support with the affected thread ID if it persists.

## Fork history

> **Fork notice (2026-09-08).** Rate-limiting, pagination, and large-thread reliability pass.
>
> 1. **Fixed the actual root cause of large-thread failures**: per-thread fetching used a raw `offset` parameter that the API silently ignores past the first page. The real mechanism is a `cursor` continuation token from each response's `next_cursor` field. Threads that appeared to need hundreds of pages were often just a few hundred entries, endlessly re-fetching the same window disguised as genuine growth. See `module-architecture.md` for the full story.
> 2. **Three-tier rate limiting** (`src/rateLimitStrategy.ts`, new) — proactive quota-header checks, then `Retry-After`, then an adaptive/fixed backoff schedule; retries 429/502/503/504 and raw network-level exceptions.
> 3. **Crash-resilient, streamed staging** — each page is appended to `<outputDir>/.staging/<slug>.partial.jsonl` as it arrives, read and written line-by-line rather than as one large string (avoiding a hard V8 string-length limit on very large threads), so an interrupted run resumes from the last complete page instead of starting over.
> 4. **Quick/deferred pass scheduling** — a thread still fetching after `--defer-after-pages` pages is parked and resumed in a second pass, so a few large threads can't block many small ones from finishing.
> 5. **New flags and higher default page limit** — see Usage above.
> 6. **Stats files relocated** to `<outputDir>/stat-files/` instead of the project root.

> **Fork notice (2026-09-05).** Builds on
> [`osedlacek/perplexport`](https://github.com/osedlacek/perplexport) (itself
> a fork of the original [`leonid-shevtsov/perplexport`](https://github.com/leonid-shevtsov/perplexport)),
> adding incremental re-export support and Central-time-stamped filenames.
>
> 1. **Filename format** — filenames now start with a `YYYYMMDDHHMMSS` prefix
>    derived from each thread's `entry_updated_datetime`, converted to
>    `America/Chicago` local time (correctly handles CST/CDT with no manual
>    offset math), replacing a creation-date suffix that didn't reflect
>    edits or sort chronologically by recency.
> 2. **Incremental re-export** — `done.json` changed from a flat array of
>    processed URLs to a map keyed by thread slug, storing each thread's
>    last-seen `updatedAt` and filename. Conversations you've continued to
>    update are now detected and re-exported automatically, without needing
>    to open every thread to check for changes.
> 3. **Stale-file cleanup** — re-exporting a previously-exported thread under
>    a new timestamp now deletes the old `.json`/`.md` pair automatically
>    instead of accumulating duplicates.
> 4. **Known limitation**: see Troubleshooting above for the HTTP 403 issue.

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

---

Original (c) 2025 [Leonid Shevtsov](https://leonid.shevtsov.me) — MIT.
Fork (c) 2026 Ondřej Sedláček — MIT.
Fork (c) 2026 Pat Kelly — MIT.
