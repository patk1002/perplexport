import fs from "fs";
import path from "path";
import type { Page } from "puppeteer";
import { withRateLimitRetry, RateLimitError, parseRetryAfter } from "./rateLimitStrategy";

export const PAGE_LIMIT = 100;
export const DEFER_AFTER_PAGES = 3; // 3 * PAGE_LIMIT = 300-entry quick-pass threshold
const MAX_PAGES = 2000; // safety cap
const BASE_PAGE_DELAY_MS = 2000;
const PAGE_DELAY_DECAY = 0.85;

export interface DoneFileEntry {
  filename: string;
  exportedAt: string;
}

export interface DoneFile {
  processed: Record<string, DoneFileEntry>;
}

export interface PageFetchRecord {
  slug: string;
  pageIndex: number;
  durationMs: number;
}

export interface ThreadResult {
  slug: string;
  pageCount: number;
  deferred: boolean;
  failed: boolean;
}

export class ConversationSaver {
  private page: Page;
  private outputDir: string;
  private doneFilePath: string;
  private verbose: boolean;
  private stagingDir: string;
  private doneFile: DoneFile;
  public pageFetchRecords: PageFetchRecord[] = [];
  public failedSlugs: string[] = [];

  constructor(page: Page, outputDir: string, doneFilePath: string, verbose = false) {
    this.page = page;
    this.outputDir = outputDir;
    this.doneFilePath = doneFilePath;
    this.verbose = verbose;
    this.stagingDir = path.join(outputDir, ".staging");
    this.doneFile = this.loadDoneFile();

    if (!fs.existsSync(this.stagingDir)) {
      fs.mkdirSync(this.stagingDir, { recursive: true });
    }
  }

  private loadDoneFile(): DoneFile {
    if (fs.existsSync(this.doneFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.doneFilePath, "utf-8"));
      } catch {
        if (this.verbose) console.log("[verbose] done file unreadable, starting fresh");
      }
    }
    return { processed: {} };
  }

  private saveDoneFile(): void {
    fs.writeFileSync(this.doneFilePath, JSON.stringify(this.doneFile, null, 2));
  }

  private log(message: string): void {
    if (this.verbose) console.log(`[verbose] ${message}`);
  }

  /** Estimates page count for a thread without deferring, used for the pass 1/2 split. */
  async estimatePageCount(slug: string): Promise<number> {
    const first = await this.fetchPage(slug, 0);
    const totalEntries = first.total ?? first.entries.length;
    return Math.max(1, Math.ceil(totalEntries / PAGE_LIMIT));
  }

  private async fetchPage(
    slug: string,
    pageIndex: number
  ): Promise<{ entries: any[]; total?: number }> {
    const start = Date.now();

    const result = await withRateLimitRetry(
      async () => {
        return await this.page.evaluate(
          async (threadSlug: string, offset: number, limit: number) => {
            const res = await fetch(
              `/rest/thread/${threadSlug}?offset=${offset}&limit=${limit}`,
              { credentials: "include" }
            );
            if (res.status === 429) {
              const retryAfter = res.headers.get("Retry-After");
              throw { __rateLimited: true, retryAfter };
            }
            if (!res.ok) {
              throw new Error(`Fetch failed: ${res.status}`);
            }
            return res.json();
          },
          slug,
          pageIndex * PAGE_LIMIT,
          PAGE_LIMIT
        );
      },
      { verbose: this.verbose, label: `${slug} page ${pageIndex}` }
    ).catch((err) => {
      if (err && err.__rateLimited) {
        throw new RateLimitError("rate limited", parseRetryAfter(err.retryAfter));
      }
      throw err;
    });

    const durationMs = Date.now() - start;
    this.pageFetchRecords.push({ slug, pageIndex, durationMs });
    this.log(`fetched page ${pageIndex} for ${slug} in ${durationMs}ms`);

    this.writeStagingPage(slug, pageIndex, result);
    return result;
  }

  private stagingPathFor(slug: string, pageIndex: number): string {
    return path.join(this.stagingDir, slug, `page-${pageIndex}.json`);
  }

  private writeStagingPage(slug: string, pageIndex: number, data: unknown): void {
    const dir = path.join(this.stagingDir, slug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.stagingPathFor(slug, pageIndex), JSON.stringify(data));
  }

  private loadStagedPages(slug: string): any[] {
    const dir = path.join(this.stagingDir, slug);
    if (!fs.existsSync(dir)) return [];
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("page-"))
      .sort((a, b) => {
        const ai = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
        const bi = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
        return ai - bi;
      });
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
  }

  private clearStaging(slug: string): void {
    const dir = path.join(this.stagingDir, slug);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Deletes the previously exported .md/.json pair for a thread before writing a new one. */
  private deleteStaleFiles(slug: string): void {
    const prev = this.doneFile.processed[slug];
    if (!prev) return;
    for (const ext of [".md", ".json"]) {
      const stalePath = path.join(this.outputDir, prev.filename.replace(/\.(md|json)$/, ext));
      if (fs.existsSync(stalePath)) {
        fs.rmSync(stalePath);
        this.log(`deleted stale file ${stalePath}`);
      }
    }
  }

  async exportThread(slug: string): Promise<ThreadResult> {
    let allEntries: any[] = [];
    let pageIndex = 0;
    let total: number | undefined;
    let delay = BASE_PAGE_DELAY_MS;
    let failed = false;

    const staged = this.loadStagedPages(slug);
    if (staged.length > 0) {
      this.log(`resuming ${slug} from ${staged.length} staged page(s)`);
      for (const p of staged) allEntries.push(...p.entries);
      pageIndex = staged.length;
      total = staged[staged.length - 1].total ?? total;
    }

    try {
      while (pageIndex < MAX_PAGES) {
        const result = await this.fetchPage(slug, pageIndex);
        allEntries.push(...result.entries);
        total = result.total ?? total;

        const fetchedAll = total !== undefined && allEntries.length >= total;
        const fetchedShortPage = result.entries.length < PAGE_LIMIT;
        pageIndex++;

        if (fetchedAll || fetchedShortPage) break;

        await new Promise((r) => setTimeout(r, delay));
        delay = Math.max(delay * PAGE_DELAY_DECAY, 250);
      }
    } catch (err) {
      failed = true;
      this.failedSlugs.push(slug);
      this.log(`failed to export ${slug}: ${(err as Error).message}`);
    }

    if (!failed) {
      this.deleteStaleFiles(slug);
      const filename = this.writeOutput(slug, allEntries);
      this.doneFile.processed[slug] = { filename, exportedAt: new Date().toISOString() };
      this.saveDoneFile();
      this.clearStaging(slug);
    }

    return { slug, pageCount: pageIndex, deferred: false, failed };
  }

  private writeOutput(slug: string, entries: any[]): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${slug}-${timestamp}.md`;
    const markdown = entries
      .map((e) => `## ${e.title ?? slug}\n\n${e.content ?? ""}`)
      .join("\n\n---\n\n");
    fs.writeFileSync(path.join(this.outputDir, filename), markdown);
    fs.writeFileSync(
      path.join(this.outputDir, filename.replace(/\.md$/, ".json")),
      JSON.stringify(entries, null, 2)
    );
    return filename;
  }

  isAlreadyDone(slug: string): boolean {
    return Boolean(this.doneFile.processed[slug]);
  }
}
