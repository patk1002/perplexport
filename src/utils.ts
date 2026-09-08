import path from "path";
import { promises as fs } from "fs";
import { DoneFile, DurationStats, PageFetchRecord, RunStats, TierUsage } from "./types";

/** Matches a Perplexity thread UUID out of a /search/<uuid> URL. Shared
 * between ConversationSaver.ts and exportLibrary.ts (the latter for parsing
 * -u/--url) so the pattern only has to be updated in one place if Perplexity
 * ever changes its URL scheme. */
export const THREAD_UUID_RE = /\/search\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export async function loadDoneFile(doneFilePath: string): Promise<DoneFile> {
  try {
    const content = await fs.readFile(doneFilePath, "utf-8");
    const parsed = JSON.parse(content);
    return { processed: parsed.processed ?? {} };
  } catch (error) {
    console.error(`Error loading done file ${doneFilePath}:`, error);
    return { processed: {} };
  }
}

export async function saveDoneFile(doneFile: DoneFile, doneFilePath: string): Promise<void> {
  await fs.writeFile(doneFilePath, JSON.stringify(doneFile, null, 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Formats an elapsed duration as "Xh Ym Zs", omitting hour/minute segments
 * that are zero, so a short single-URL run doesn't print "0h 0m 12s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function computeMode(values: number[]): number {
  // Bucket to the nearest 100ms so near-identical fetch times count as the
  // same "typical" duration instead of each being its own singleton mode.
  const buckets = new Map<number, number>();
  for (const v of values) {
    const bucket = Math.round(v / 100) * 100;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  let mode = values[0];
  let modeCount = 0;
  for (const [bucket, count] of buckets) {
    if (count > modeCount) {
      modeCount = count;
      mode = bucket;
    }
  }
  return mode;
}

export function computeDurationStats(records: PageFetchRecord[]): DurationStats {
  if (records.length === 0) {
    return { min: 0, max: 0, mean: 0, mode: 0, stdDev: 0, count: 0 };
  }
  const durations = records.map((r) => r.durationMs);
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;

  return {
    min: Math.round(min),
    max: Math.round(max),
    mean: Math.round(mean),
    mode: Math.round(computeMode(durations)),
    stdDev: Math.round(Math.sqrt(variance)),
    count: durations.length,
  };
}

export function computeTierUsage(records: PageFetchRecord[]): TierUsage {
  const usage: TierUsage = { quotaHeader: 0, retryAfter: 0, aimd: 0 };
  for (const r of records) {
    if (r.tier === "quota-header") usage.quotaHeader += 1;
    else if (r.tier === "retry-after") usage.retryAfter += 1;
    else usage.aimd += 1;
  }
  return usage;
}

export function buildRunStats(
  pass: RunStats["pass"],
  startedAt: number,
  records: PageFetchRecord[],
  failedSlugs: string[],
  safetyCapSlugs: string[],
  threadsProcessed: number,
  threadsDeferred: number
): RunStats {
  const finishedAt = Date.now();
  return {
    pass,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedMs: finishedAt - startedAt,
    threadsProcessed,
    threadsDeferred,
    threadsFailed: failedSlugs.length,
    failedSlugs,
    safetyCapSlugs,
    pageFetchDurationMs: computeDurationStats(records),
    tierUsage: computeTierUsage(records),
  };
}

/** Writes a uniquely-timestamped stats file to `<outputDir>/stat-files/`
 * (created if needed) so a run never overwrites a prior run's summary, and
 * so these diagnostic files live alongside the export output rather than
 * cluttering the project root next to done.json -- as a side benefit, this
 * also means they're automatically covered by any .gitignore rule that
 * already excludes outputDir, with no separate pattern needed. Named after
 * doneFilePath's own basename to keep the existing naming convention, e.g.
 * `my-export/stat-files/done.json.stats-quick-20260908101500.json`. */
export async function writeRunStats(outputDir: string, doneFilePath: string, stats: RunStats): Promise<void> {
  const statsDir = path.join(outputDir, "stat-files");
  await fs.mkdir(statsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const doneFileBasename = path.basename(doneFilePath);
  const statsPath = path.join(statsDir, `${doneFileBasename}.stats-${stats.pass}-${timestamp}.json`);

  await fs.writeFile(statsPath, JSON.stringify(stats, null, 2));
  console.log(`  Wrote ${stats.pass}-pass stats to ${statsPath}`);
}

/** Converts a UTC ISO timestamp to a sortable `YYYYMMDDHHMMSS` string in a
 * given IANA time zone (default America/Chicago), correctly handling
 * DST transitions via Intl.DateTimeFormat instead of manual offset math. */
export function formatLocalTimestamp(isoString: string, timeZone = "America/Chicago"): string {
  const date = new Date(isoString);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
}

/**
 * Scans a thread's entries for the LATEST `entry_updated_datetime`, not
 * `entries[0]` -- trusting index 0 only ever "worked" by coincidence on
 * small, single-page test threads; pagination ordering across a
 * multi-hundred-entry thread is not guaranteed to put the most recently
 * updated entry first. Falls back to the current time only if no entry has
 * a usable timestamp at all (should not happen in practice).
 *
 * This is also the correct value to use as a Conversation's `updatedAt`
 * when one wasn't available from the library-listing GraphQL query (e.g.
 * in -u/--url single-thread mode) -- using the actual current time instead
 * would silently defeat done.json's skip-if-unchanged comparison, since an
 * arbitrary "when this command happened to run" timestamp will essentially
 * never match Perplexity's real per-thread updatedAt on a later full run.
 */
export function getLatestEntryUpdatedAt(entries: Array<{ entry_updated_datetime?: string }>): string {
  let latestUpdatedAt = "";
  let latestMs = -Infinity;
  for (const e of entries) {
    const t = e.entry_updated_datetime;
    if (!t) continue;
    const ms = new Date(t).getTime();
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latestUpdatedAt = t;
    }
  }
  return latestUpdatedAt || new Date().toISOString();
}

/**
 * Builds an output filename from the thread's latest updated-at timestamp
 * (see getLatestEntryUpdatedAt above), converted to a sortable local
 * timestamp prefix plus a sanitized title.
 */
export function buildFilename(entries: Array<{ thread_title?: string; entry_updated_datetime?: string }>, fallbackId: string): string {
  const title = entries.find((e) => e.thread_title)?.thread_title ?? fallbackId;
  const timestamp = formatLocalTimestamp(getLatestEntryUpdatedAt(entries));

  const safeTitle = title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);

  return `${timestamp} ${safeTitle}`;
}
