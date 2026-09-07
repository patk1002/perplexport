import fs from "fs";
import puppeteer from "puppeteer";
import { ConversationSaver, DEFER_AFTER_PAGES, PageFetchRecord } from "./ConversationSaver";

export interface ExportLibraryOptions {
  outputDir: string;
  doneFilePath: string;
  email: string;
  verbose: boolean;
}

interface RunStats {
  startedAt: string;
  finishedAt: string;
  threadsProcessed: number;
  threadsDeferred: number;
  threadsFailed: number;
  failedSlugs: string[];
  pageFetchDurationMs: {
    min: number;
    max: number;
    mean: number;
    mode: number;
    stdDev: number;
    count: number;
  };
}

function computeDurationStats(records: PageFetchRecord[]): RunStats["pageFetchDurationMs"] {
  if (records.length === 0) {
    return { min: 0, max: 0, mean: 0, mode: 0, stdDev: 0, count: 0 };
  }
  const durations = records.map((r) => r.durationMs);
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;

  const variance =
    durations.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / durations.length;
  const stdDev = Math.sqrt(variance);

  // Mode: bucket to nearest 100ms to find the most common "typical" fetch time.
  const buckets = new Map<number, number>();
  for (const d of durations) {
    const bucket = Math.round(d / 100) * 100;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  let mode = durations[0];
  let modeCount = 0;
  for (const [bucket, count] of buckets) {
    if (count > modeCount) {
      modeCount = count;
      mode = bucket;
    }
  }

  return {
    min: Math.round(min),
    max: Math.round(max),
    mean: Math.round(mean),
    mode: Math.round(mode),
    stdDev: Math.round(stdDev),
    count: durations.length,
  };
}

function writeStatsFile(doneFilePath: string, stats: RunStats): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const statsPath = `${doneFilePath}.stats-${timestamp}.json`;
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
}

export default async function exportLibrary(options: ExportLibraryOptions): Promise<void> {
  const { outputDir, doneFilePath, email, verbose } = options;
  const startedAt = new Date().toISOString();

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  if (verbose) {
    page.on("console", (msg) => console.log(`[browser] ${msg.text()}`));
  }

  // ... authentication flow using `email` happens here (unchanged from prior steps) ...

  const saver = new ConversationSaver(page, outputDir, doneFilePath, verbose);

  const allSlugs: string[] = await page.evaluate(async () => {
    const res = await fetch("/rest/library", { credentials: "include" });
    const data = await res.json();
    return data.threads.map((t: { slug: string }) => t.slug);
  });

  const pending = allSlugs.filter((slug) => !saver.isAlreadyDone(slug));

  const quickPass: string[] = [];
  const deferredPass: string[] = [];

  for (const slug of pending) {
    const estimatedPages = await saver.estimatePageCount(slug);
    if (estimatedPages <= DEFER_AFTER_PAGES) {
      quickPass.push(slug);
    } else {
      deferredPass.push(slug);
      if (verbose) {
        console.log(`[verbose] deferring ${slug} (~${estimatedPages} pages) to pass 2`);
      }
    }
  }

  let threadsProcessed = 0;

  for (const slug of quickPass) {
    await saver.exportThread(slug);
    threadsProcessed++;
  }

  for (const slug of deferredPass) {
    await saver.exportThread(slug);
    threadsProcessed++;
  }

  await browser.close();

  const stats: RunStats = {
    startedAt,
    finishedAt: new Date().toISOString(),
    threadsProcessed,
    threadsDeferred: deferredPass.length,
    threadsFailed: saver.failedSlugs.length,
    failedSlugs: saver.failedSlugs,
    pageFetchDurationMs: computeDurationStats(saver.pageFetchRecords),
  };

  writeStatsFile(doneFilePath, stats);

  if (verbose) {
    console.log(`[verbose] run complete: ${JSON.stringify(stats, null, 2)}`);
  }
}
