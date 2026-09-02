import { Page } from "puppeteer";
import { ConversationResponse } from "./types/conversation";

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

  // Direct fetch against /rest/thread/<uuid>?limit=1000 with offset pagination.
  //
  // Why not the listener-based approach the original used: the SPA's natural
  // call uses limit=10, which silently truncates threads with >10 turns. There
  // is no way to bump that limit without intercepting and rewriting the request,
  // which is fragile. Calling the API directly with limit=1000 and paginating
  // via offset until has_next_page=false captures full thread history.
  //
  // Bonus: skipping page navigation per thread is ~10x faster and avoids
  // detached-frame errors that pile up when scraping hundreds of threads.
  async loadThreadFromURL(url: string): Promise<ThreadData> {
    const m = UUID_RE.exec(url);
    if (!m) {
      throw new Error(`Could not extract thread UUID from URL: ${url}`);
    }
    const threadId = m[1];

    return await this.page.evaluate(
      async (tid: string, blocks: string[]): Promise<ThreadData> => {
        const PAGE_LIMIT = 25;
        let offset = 0;
        let merged: ConversationResponse | null = null;
        const blocksParam = blocks.map((b) => `supported_block_use_cases=${b}`).join("&");
        for (let i = 0; i < 50; i++) {
          const u = `/rest/thread/${tid}?with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=${PAGE_LIMIT}&offset=${offset}&from_first=true&${blocksParam}`;
          const resp = await fetch(u, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} fetching thread ${tid} (offset=${offset})`);
          }
          const data = (await resp.json()) as ConversationResponse;
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
          if (!(data as any).has_next_page) break;
          if (entries.length === 0) break;
          offset += entries.length;
        }
        return { id: tid, conversation: merged as ConversationResponse };
      },
      threadId,
      SUPPORTED_BLOCKS
    );
  }
}
