import type { ThrottleTier } from "./rateLimitStrategy";

/** One conversation as returned by the library listing. */
export interface Conversation {
  title: string;
  url: string;
  slug: string;
  updatedAt: string;
}

export interface DoneEntry {
  updatedAt: string;
  filename: string;
}

/** Persisted record of what's already been exported, keyed by thread slug. */
export interface DoneFile {
  processed: Record<string, DoneEntry>;
}

export interface ExportLibraryOptions {
  outputDir: string;
  doneFilePath: string;
  email: string;
  /** -v / --verbose: opt-in detailed logging (browser console, per-page timing, retry tiers). */
  verbose: boolean;
  /** -u / --url: process exactly one thread URL, skipping the full library scan. */
  url?: string;
  /** --page-limit: entries fetched per API page. Default 100. */
  pageLimit: number;
  /** --defer-after-pages: pages after which a thread is parked for pass 2. Default 3. */
  deferAfterPages: number;
  /** --rate-limit-retries: max retries for a rate-limited page fetch. Default 7. */
  rateLimitRetries: number;
}

/** Timing + outcome for a single page fetch, used for end-of-run diagnostics. */
export interface PageFetchRecord {
  slug: string;
  pageIndex: number;
  durationMs: number;
  tier: ThrottleTier;
  retries: number;
}

export interface ThreadResult {
  slug: string;
  pageCount: number;
  deferred: boolean;
  failed: boolean;
  /** True if MAX_PAGES safety cap was hit -- content may be truncated. Always
   * surfaced explicitly; a safety cap must never fail silently. */
  hitSafetyCap: boolean;
}

export interface DurationStats {
  min: number;
  max: number;
  mean: number;
  mode: number;
  stdDev: number;
  count: number;
}

export interface TierUsage {
  quotaHeader: number;
  retryAfter: number;
  aimd: number;
}

/** One pass's worth of end-of-run diagnostics. Pass 1 ("quick") and pass 2
 * ("deferred") get their own separate files -- a marathon thread's retry
 * behavior in pass 2 shouldn't be diluted into the same mean/mode/stdDev as
 * dozens of small, clean pass-1 threads. */
export interface RunStats {
  pass: "quick" | "deferred" | "single";
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  threadsProcessed: number;
  threadsDeferred: number;
  threadsFailed: number;
  failedSlugs: string[];
  safetyCapSlugs: string[];
  pageFetchDurationMs: DurationStats;
  tierUsage: TierUsage;
}
