
import { Page } from "puppeteer";
import { ConversationResponse } from "./types/conversation";
import { sleep } from "./utils";

interface ThreadData {
  id: string;
  conversation: ConversationResponse;
}

// Block use cases the Perplexity SPA requests when fetching a thread. Including
// these makes the response shape identical to what renderConversation expects.
const SUPPORTED_BLOCKS = [
  "answer_modes", "media_items", "knowledge_cards", "inline_entity_cards", "place_widgets",
  "finance_widgets", "prediction_market_widgets", "sports_widgets", "flight_status_widgets",
  "news_widgets", "shopping_widgets", "jobs_widgets", "search_result_widgets", "inline_images",
  "inline_assets", "placeholder_cards", "diff_blocks", "inline_knowledge_cards", "entity_group_v2",
  "refinement_filters", "canvas_mode", "maps_preview", "answer_tabs", "price_comparison_widgets",
  "preserve_latex", "generic_onboarding_widgets", "in_context_suggestions", "pending_followups",
  "inline_claims", "unified_assets", "workflow_steps", "background_agents",
];

const UUID_RE = /\/search\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const PAGE_LIMIT = 25;
const PAGE_DELAY_MS = 5_000;        // Wait 5 seconds after each successful page.
const RATE_LIMIT_WAIT_MS = 60_000;  // Wait 60 seconds after HTTP 429.
const RATE_LIMIT_RETRIES = 5;       // Retry a rate-limited page up to five times.
const MAX_PAGES = 2000;             // Safety cap: 2000 * 25 = 50,000 entries max.

type PageFetchResult =
  | { ok: true; data: ConversationResponse }
  | { ok: false; status: number | string };

export class ConversationSaver {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // Kept for API backwards-compat with the listener-based original. The new
  // direct-fetch implementation needs no setup, but exportLibrary still calls it.
  async initialize(): Promise<void> {
    /* no-op */
  }

  // Fetches a single page of a thread. This runs as its own short-lived
  // page.evaluate() call — deliberately NOT looped inside the browser
  // context — so that Puppeteer's protocolTimeout only ever has to cover
  // one fetch (plus its own 429 retries), regardless of how many total
  // pages a very long thread needs. A single evaluate() call that loops
  // internally across hundreds of pages with multi-second delays can
  // exceed protocolTimeout and die with "Runtime.callFunctionOn timed out"
  // even though each individual fetch is fast.
  private async fetchPage(
    tid: string,
    offset: number
  ): Promise<PageFetchResult> {
    return await this.page.evaluate(
      async (
        threadId: string,
        blocks: string[],
        off: number,
        limit: number,
        rateLimitWaitMs: number,
        rateLimitRetries: number
      ): Promise<PageFetchResult> => {
        const blocksParam = blocks.map((b) => `supported_block_use_cases=${b}`).join("&");
        const u = `/rest/thread/${threadId}?with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=${limit}&offset=${off}&from_first=true&${blocksParam}`;

        let resp: Response | undefined;
        for (let attempt = 1; attempt <= rateLimitRetries; attempt++) {
          resp = await fetch(u, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (resp.status !== 429) break;
          await new Promise<void>((resolve) => setTimeout(resolve, rateLimitWaitMs));
        }

        if (!resp || !resp.ok) {
          return { ok: false, status: resp?.status ?? "unknown" };
        }

        const data = (await resp.json()) as ConversationResponse;
        return { ok: true, data };
      },
      tid,
      SUPPORTED_BLOCKS,
      offset,
      PAGE_LIMIT,
      RATE_LIMIT_WAIT_MS,
      RATE_LIMIT_RETRIES
    );
  }

  // Direct fetch against /rest/thread/<uuid>, paginated via offset until
  // has_next_page=false. Pagination and inter-page delay happen here in
  // Node, not inside a single browser-context loop — see fetchPage() above
  // for why that distinction matters for very long threads.
  async loadThreadFromURL(url: string): Promise<ThreadData> {
    const m = UUID_RE.exec(url);
    if (!m) {
      throw new Error(`Could not extract thread UUID from URL: ${url}`);
    }
    const threadId = m[1];

    let offset = 0;
    let merged: ConversationResponse | null = null;
    let hitSafetyCap = true;

    for (let i = 0; i < MAX_PAGES; i++) {
      const result = await this.fetchPage(threadId, offset);

      if (!result.ok) {
        throw new Error(
          `HTTP ${result.status} fetching thread ${threadId} (offset=${offset})`
        );
      }

      const data = result.data;
      const entries = (data as any).entries || [];

      if (merged === null) {
        merged = data;
      } else {
        (merged as any).entries = ((merged as any).entries || []).concat(entries);
        (merged as any).background_entries = ((merged as any).background_entries || []).concat(
          (data as any).background_entries || []
        );
        (merged as any).has_next_page = (data as any).has_next_page;
        (merged as any).next_cursor = (data as any).next_cursor;
      }

      if (!(data as any).has_next_page) {
        hitSafetyCap = false;
        break;
      }
      if (entries.length === 0) {
        hitSafetyCap = false;
        break;
      }
      offset += entries.length;
      await sleep(PAGE_DELAY_MS);
    }

    if (hitSafetyCap) {
      console.error(
        `  WARNING: thread ${threadId} hit the pagination safety cap (${MAX_PAGES} pages) ` +
        `— content may be truncated.`
      );
    }

    return { id: threadId, conversation: merged as ConversationResponse };
  }
}
