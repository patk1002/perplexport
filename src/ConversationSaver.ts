import fs from "fs";
import path from "path";
import readline from "readline";
import type { Page } from "puppeteer";
import {
  AdaptiveDelay,
  fetchWithTieredRetry,
  RATE_LIMIT_RETRIES,
  RawFetchResult,
  RateLimitError,
} from "./rateLimitStrategy";
import renderConversation from "./renderConversation";
import { buildFilename, loadDoneFile, saveDoneFile, THREAD_UUID_RE } from "./utils";
import { Conversation, DoneFile, PageFetchRecord, ThreadResult } from "./types";
import type { ConversationEntry, ConversationResponse } from "./types/conversation";

// Block use cases the Perplexity SPA requests when fetching a thread.
// Including these makes the response shape identical to what
// renderConversation expects. Unchanged from the working implementation.
const SUPPORTED_BLOCKS = [
  "answer_modes", "media_items", "knowledge_cards", "inline_entity_cards", "place_widgets",
  "finance_widgets", "prediction_market_widgets", "sports_widgets", "flight_status_widgets",
  "news_widgets", "shopping_widgets", "jobs_widgets", "search_result_widgets", "inline_images",
  "inline_assets", "placeholder_cards", "diff_blocks", "inline_knowledge_cards", "entity_group_v2",
  "refinement_filters", "canvas_mode", "maps_preview", "answer_tabs", "price_comparison_widgets",
  "preserve_latex", "generic_onboarding_widgets", "in_context_suggestions", "pending_followups",
  "inline_claims", "unified_assets", "workflow_steps", "background_agents",
];

/** Default entries fetched per API page. Raised from 25 -> 100: fewer round
 * trips per thread means fewer opportunities to hit a 429, which was the
 * actual root cause of large-thread failures (not, as first suspected,
 * stale internal JSON). 1000 was tried and tested first but caused
 * consistent failures -- 100 is the current, evidence-based default.
 * Overridable per-run via --page-limit. */
export const DEFAULT_PAGE_LIMIT = 100;

/** Default pages after which a still-fetching thread is deferred to pass 2
 * (300 entries at the default page limit). Overridable via --defer-after-pages. */
export const DEFAULT_DEFER_AFTER_PAGES = 3;

/** Safety cap: 2000 pages max per thread regardless of page-limit setting.
 * Hitting this is ALWAYS logged loudly and reflected in
 * ThreadResult.hitSafetyCap -- a silent truncation (the previous
 * 50-iteration cap's failure mode) is worse than a crash, because nothing
 * tells you it happened. */
const MAX_PAGES = 2000;

/**
 * The real `/rest/thread/<uuid>` response, as declared in
 * types/conversation.ts, PLUS `background_entries` -- which the verified
 * real ConversationSaver.ts already reads via an `any` cast, confirming
 * the API genuinely returns it even though ConversationResponse doesn't
 * declare it. Extended here locally rather than editing that shared file
 * without confirmation.
 */
type RawPageResponse = ConversationResponse & { background_entries?: unknown[] };

export interface ConversationSaverOptions {
  outputDir: string;
  doneFilePath: string;
  verbose?: boolean;
  pageLimit?: number;
  rateLimitRetries?: number;
}

export interface ThreadFetchState {
  conversation: Conversation;
  threadId: string;
  status: string;
  entries: ConversationEntry[];
  backgroundEntries: unknown[];
  offset: number;
  pageIndex: number;
  hasNextPage: boolean;
  hitSafetyCap: boolean;
  adaptive: AdaptiveDelay;
}

interface StagedPage {
  pageIndex: number;
  status: string;
  entries: ConversationEntry[];
  backgroundEntries: unknown[];
  hasNextPage: boolean;
}

/** Writes one JSON array field ("entries" or "background_entries") to an
 * already-open write stream, item by item, WITHOUT ever calling
 * JSON.stringify() on the whole array. Shared by both fields in
 * writeJsonStreaming() because both turned out to need the same
 * treatment: a first attempt streamed only `entries` and left
 * `background_entries` as a single JSON.stringify() call, on the
 * assumption (true for every other thread seen so far) that it would be
 * small -- but on this ~34,500+ entry, 340+-page deep-research thread,
 * background_entries proved large enough to hit V8's string-length limit
 * on its own, independent of the main entries array. */
function writeJsonArrayField(stream: fs.WriteStream, fieldName: string, items: unknown[], isLastField: boolean): void {
  stream.write(`  "${fieldName}": [\n`);
  const lastIndex = items.length - 1;
  items.forEach((item, i) => {
    const indented = JSON.stringify(item, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    stream.write(indented + (i === lastIndex ? "\n" : ",\n"));
  });
  stream.write(isLastField ? "  ]\n" : "  ],\n");
}

/**
 * Writes a JSON file shaped like `{ status, entries: [...], background_entries:
 * [...], has_next_page, next_cursor }` WITHOUT ever calling
 * JSON.stringify() on the whole object, or on either array field as a
 * whole. V8 caps any single string at 0x1fffffe8 characters (~536.8
 * million) -- a hard engine limit, not configurable. Both array fields are
 * streamed item-by-item so no single string involved in producing this
 * file is ever more than one array item's worth of content, regardless of
 * how large either array is in total.
 *
 * Note: this was never actually the crash site on the ~34,500-entry thread
 * that motivated this whole file -- see loadStagingLines() below for where
 * the real limit was being hit, before this function ever ran. Streaming
 * both fields here remains correct defensive practice regardless: nothing
 * stops a future thread's `entries` or `background_entries` array alone
 * from eventually exceeding the limit even after loadStagingLines is fixed.
 */
function writeJsonStreaming(
  filePath: string,
  merged: { status: string; entries: ConversationEntry[]; backgroundEntries: unknown[]; hasNextPage: boolean; nextCursor: null }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    stream.on("error", reject);
    stream.on("finish", resolve);

    stream.write("{\n");
    stream.write(`  "status": ${JSON.stringify(merged.status)},\n`);
    stream.write(`  "has_next_page": ${JSON.stringify(merged.hasNextPage)},\n`);
    stream.write(`  "next_cursor": ${JSON.stringify(merged.nextCursor)},\n`);
    writeJsonArrayField(stream, "background_entries", merged.backgroundEntries, false);
    writeJsonArrayField(stream, "entries", merged.entries, true);
    stream.write("}\n");
    stream.end();
  });
}

/**
 * Per-thread fetch engine. Exposes resumable primitives (startThread /
 * fetchNextPage / finalizeThread) so the caller (exportLibrary.ts) can pause
 * a thread after a bounded number of pages -- for the quick-pass/deferred-
 * pass split -- and later resume it exactly where it left off, without
 * re-fetching or re-risking 429s on pages already fetched.
 *
 * Owns per-thread durability (staging JSONL), final .json/.md output,
 * stale-file cleanup, and done.json bookkeeping -- consolidating
 * responsibilities that module-architecture.md assigns to this class.
 */
export class ConversationSaver {
  private page: Page;
  private readonly outputDir: string;
  private readonly doneFilePath: string;
  private readonly verbose: boolean;
  private readonly pageLimit: number;
  private readonly rateLimitRetries: number;
  private readonly stagingDir: string;
  private doneFile: DoneFile;

  /** Accumulated across the whole run (survives page recreation via setPage). */
  public pageFetchRecords: PageFetchRecord[] = [];
  public failedSlugs: string[] = [];
  public safetyCapSlugs: string[] = [];

  constructor(page: Page, options: ConversationSaverOptions) {
    this.page = page;
    this.outputDir = options.outputDir;
    this.doneFilePath = options.doneFilePath;
    this.verbose = options.verbose ?? false;
    this.pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.rateLimitRetries = options.rateLimitRetries ?? RATE_LIMIT_RETRIES;
    this.stagingDir = path.join(this.outputDir, ".staging");
    this.doneFile = { processed: {} };

    if (!fs.existsSync(this.stagingDir)) {
      fs.mkdirSync(this.stagingDir, { recursive: true });
    }
  }

  /** Loads done.json from disk. Call once before the run starts. */
  async initialize(): Promise<void> {
    this.doneFile = await loadDoneFile(this.doneFilePath);
    console.log(`Loaded ${Object.keys(this.doneFile.processed).length} processed threads from done file`);
  }

  /** Read-only snapshot for getConversations() to filter against. */
  getDoneFileSnapshot(): DoneFile {
    return this.doneFile;
  }

  isAlreadyDone(slug: string): boolean {
    return Boolean(this.doneFile.processed[slug]);
  }

  /** Swaps the underlying Puppeteer page after a frame-error recovery,
   * WITHOUT constructing a new ConversationSaver -- this preserves
   * pageFetchRecords, failedSlugs, safetyCapSlugs, and the in-memory
   * doneFile across the recovery, instead of silently losing them. */
  setPage(page: Page): void {
    this.page = page;
  }

  private log(message: string): void {
    if (this.verbose) console.log(`[verbose] ${message}`);
  }

  // -- Staging (crash resilience) ------------------------------------------

  private stagingPathFor(slug: string): string {
    return path.join(this.stagingDir, `${slug}.partial.jsonl`);
  }

  private appendStagingLine(slug: string, page: StagedPage): void {
    fs.appendFileSync(this.stagingPathFor(slug), `${JSON.stringify(page)}\n`);
  }

  /** Reads the JSONL staging file back in line-by-line via a stream,
   * WITHOUT ever calling fs.readFileSync() to load the whole file as one
   * string. Confirmed live as the actual root cause of a repeated,
   * misdiagnosed crash: fs.readFileSync(path, "utf-8") on this thread's
   * 688MB staging file produced a single ~688-million-character JS
   * string, exceeding V8's 0x1fffffe8 (~536.8M) hard limit -- and it threw
   * from INSIDE startThread(), before the fetch loop ever ran, which is
   * why two earlier rounds of fixes to the JSON *writer* never had a
   * chance to matter: execution never got that far. Each individual line
   * here (one page's worth of data, a few MB at most) is nowhere near the
   * limit, so streaming line-by-line resolves it regardless of total file
   * size. */
  private async loadStagingLines(slug: string): Promise<StagedPage[]> {
    const stagingPath = this.stagingPathFor(slug);
    if (!fs.existsSync(stagingPath)) return [];

    const pages: StagedPage[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(stagingPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        pages.push(JSON.parse(trimmed));
      } catch {
        // A truncated trailing line means the process crashed mid-write
        // (including a disk-full failure mid-append). JSONL's
        // one-object-per-line format makes this harmless: every earlier
        // line is a complete, independently-parseable object, so we
        // discard only the incomplete tail and resume from the last good line.
        this.log(`discarding truncated staging line for ${slug} (crash recovery)`);
      }
    }
    return pages;
  }

  private clearStaging(slug: string): void {
    const stagingPath = this.stagingPathFor(slug);
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath);
  }

  // -- Resumable fetch primitives -------------------------------------------

  /** Begins (or resumes, if a staging file exists) fetching a thread. */
  async startThread(conversation: Conversation): Promise<ThreadFetchState> {
    const match = THREAD_UUID_RE.exec(conversation.url);
    if (!match) {
      throw new Error(`Could not extract thread UUID from URL: ${conversation.url}`);
    }
    const threadId = match[1];

    const staged = await this.loadStagingLines(conversation.slug);
    const entries: ConversationEntry[] = [];
    const backgroundEntries: unknown[] = [];
    let pageIndex = 0;
    let hasNextPage = true;
    let status = "";

    for (const stagedPage of staged) {
      entries.push(...stagedPage.entries);
      backgroundEntries.push(...stagedPage.backgroundEntries);
      pageIndex = stagedPage.pageIndex + 1;
      hasNextPage = stagedPage.hasNextPage;
      status = stagedPage.status;
    }
    if (staged.length > 0) {
      this.log(`resuming ${conversation.slug} from ${staged.length} staged page(s), ${entries.length} entries recovered`);
    }

    return {
      conversation,
      threadId,
      status,
      entries,
      backgroundEntries,
      offset: entries.length,
      pageIndex,
      hasNextPage,
      hitSafetyCap: false,
      adaptive: new AdaptiveDelay(),
    };
  }

  isDone(state: ThreadFetchState): boolean {
    return !state.hasNextPage || state.hitSafetyCap;
  }

  /** The ONLY thing that runs inside page.evaluate: a single bare fetch,
   * returning plain, serializable status/headers/body data. All retry
   * decisions happen in Node afterwards (see fetchNextPage), so no single
   * Puppeteer call ever has to contain a retry loop -- eliminating the
   * protocolTimeout risk a stacked in-browser retry loop would carry. */
  private async rawFetchPageOnce(threadId: string, offset: number): Promise<RawFetchResult> {
    return this.page.evaluate(
      async (tid: string, off: number, limit: number, blocks: string[]): Promise<RawFetchResult> => {
        const blocksParam = blocks.map((b) => `supported_block_use_cases=${b}`).join("&");
        const url = `/rest/thread/${tid}?with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=${limit}&offset=${off}&from_first=true&${blocksParam}`;

        const resp = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        const headers: Record<string, string> = {};
        resp.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const bodyText = await resp.text();
        return { status: resp.status, headers, bodyText };
      },
      threadId,
      offset,
      this.pageLimit,
      SUPPORTED_BLOCKS
    );
  }

  /** Fetches exactly one more page for `state`, mutating and returning it.
   * Bounded unit of work: safe to call in a loop from exportLibrary.ts,
   * pausing after any call without losing progress (each successful page
   * is appended to the staging file immediately). */
  async fetchNextPage(state: ThreadFetchState): Promise<ThreadFetchState> {
    const start = Date.now();
    const label = `${state.conversation.slug} page ${state.pageIndex}`;

    const { data, attempts, tier } = await fetchWithTieredRetry(
      () => this.rawFetchPageOnce(state.threadId, state.offset),
      (bodyText) => JSON.parse(bodyText) as RawPageResponse,
      { verbose: this.verbose, label, adaptive: state.adaptive, maxRetries: this.rateLimitRetries }
    );

    const durationMs = Date.now() - start;
    const pageEntries = data.entries ?? [];
    const pageBackgroundEntries = data.background_entries ?? [];

    this.pageFetchRecords.push({
      slug: state.conversation.slug,
      pageIndex: state.pageIndex,
      durationMs,
      tier,
      retries: attempts - 1,
    });
    this.log(`fetched page ${state.pageIndex} for ${state.conversation.slug}: ${pageEntries.length} entries in ${durationMs}ms (tier=${tier})`);

    this.appendStagingLine(state.conversation.slug, {
      pageIndex: state.pageIndex,
      status: data.status,
      entries: pageEntries,
      backgroundEntries: pageBackgroundEntries,
      hasNextPage: Boolean(data.has_next_page),
    });

    // ConversationResponse.status is a required string, so no fallback is needed here.
    state.status = data.status;
    state.entries.push(...pageEntries);
    state.backgroundEntries.push(...pageBackgroundEntries);
    state.offset += pageEntries.length;
    state.pageIndex += 1;
    state.hasNextPage = Boolean(data.has_next_page) && pageEntries.length > 0;

    if (state.pageIndex >= MAX_PAGES && state.hasNextPage) {
      state.hitSafetyCap = true;
      this.safetyCapSlugs.push(state.conversation.slug);
      console.error(
        `  WARNING: thread ${state.conversation.slug} hit the pagination safety cap (${MAX_PAGES} pages) -- content is truncated.`
      );
    }

    return state;
  }

  /** Deletes the previously exported .md/.json pair for a thread. Called
   * only AFTER the new pair is confirmed written -- see finalizeThread()
   * for why the ordering matters. */
  private deleteStaleFiles(slug: string): void {
    const previous = this.doneFile.processed[slug];
    if (!previous) return;
    for (const ext of [".json", ".md"]) {
      const stalePath = path.join(this.outputDir, previous.filename.replace(/\.(json|md)$/, ext));
      if (fs.existsSync(stalePath)) {
        fs.rmSync(stalePath);
        this.log(`deleted stale file ${stalePath}`);
      }
    }
  }

  /** Writes the final .json/.md pair, updates done.json (saved immediately
   * -- the smallest safely-atomic checkpoint unit, so a crash on thread N+1
   * never costs you thread N), and clears the staging file only after both
   * permanent files and done.json are safely on disk.
   *
   * Deliberately writes the NEW files before deleting the OLD stale ones
   * (reordered from an earlier version that deleted first): if a write
   * fails partway -- disk full, permissions, anything -- the old pair
   * stays intact instead of being deleted with nothing to replace it. */
  async finalizeThread(state: ThreadFetchState): Promise<ThreadResult> {
    const { slug } = state.conversation;

    const filename = buildFilename(state.entries, slug);

    await writeJsonStreaming(path.join(this.outputDir, `${filename}.json`), {
      status: state.status,
      entries: state.entries,
      backgroundEntries: state.backgroundEntries,
      hasNextPage: false,
      nextCursor: null,
    });

    const merged: RawPageResponse = {
      status: state.status,
      entries: state.entries,
      background_entries: state.backgroundEntries,
      has_next_page: false,
      next_cursor: null,
    };

    let markdown: string;
    try {
      markdown = renderConversation(merged);
    } catch (renderErr) {
      const message = (renderErr as Error).message;
      console.error(`  Render failed (saving JSON only): ${message}`);
      markdown = `# Render error\n\nSee ${filename}.json for raw data.\n\nError: ${message}\n`;
    }
    fs.writeFileSync(path.join(this.outputDir, `${filename}.md`), markdown);

    this.deleteStaleFiles(slug);

    this.doneFile.processed[slug] = { updatedAt: state.conversation.updatedAt, filename };
    await saveDoneFile(this.doneFile, this.doneFilePath);
    this.clearStaging(slug);

    return {
      slug,
      pageCount: state.pageIndex,
      deferred: false,
      failed: false,
      hitSafetyCap: state.hitSafetyCap,
    };
  }
}

export { RateLimitError };
