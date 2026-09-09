import fs from "fs";
import puppeteer from "puppeteer-extra";
import { Browser, Page } from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { ConversationSaver, ThreadFetchState } from "./ConversationSaver";
import { getConversations } from "./listConversations";
import { login } from "./login";
import { HttpStatusError } from "./rateLimitStrategy";
import { buildRunStats, formatDuration, getLatestEntryUpdatedAt, sleep, THREAD_UUID_RE, writeRunStats } from "./utils";
import { Conversation, ExportLibraryOptions } from "./types";

/** Errors that mean the Puppeteer page/frame/session died and needs
 * recreating, not that the request itself failed. Cookies persist on the
 * browser context, so recovery never requires re-login. */
function isFrameError(message: string): boolean {
  return (
    message.includes("detached Frame") ||
    message.includes("Target closed") ||
    message.includes("Session closed") ||
    message.includes("Protocol error") ||
    message.includes("Runtime.callFunctionOn timed out")
  );
}

/** Logs a failure alongside an explicit reminder that progress is not
 * lost -- every successfully-fetched page for this thread is already on
 * disk in its JSONL staging file, and rerunning the same command resumes
 * from there instead of starting over. Added after a live 114-minute run
 * on a ~34,500-entry thread was aborted by a single HTTP 504, which (before
 * this) just logged a bare error with no indication that nothing had
 * actually been lost.
 *
 * A 401/403 gets an additional, more specific hint: unlike a transient
 * gateway error, an auth failure might mean the session genuinely expired
 * mid-run, in which case simply rerunning (without a fresh login) won't
 * help. Phrased as a possibility, not a certainty -- it could still just be
 * a one-off blip on an otherwise-valid session, in which case rerunning
 * resumes normally.
 *
 * Logs err.stack (when available), not just err.message: a bare message
 * like "Cannot create a string longer than 0x1fffffe8 characters" gives no
 * indication of WHICH line threw it, which mattered in practice -- two
 * rounds of guesses (the whole merged object, then just background_entries)
 * both missed the actual site because nothing surfaced the stack trace to
 * confirm or rule them out directly. */
function logFailureWithResumeHint(url: string, slug: string, outputDir: string, err: unknown): void {
  const error = err as Error;
  console.error(`  FAILED ${url}: ${error.message ?? String(err)}`);
  if (error?.stack) {
    console.error(`  Stack trace:\n${error.stack}`);
  }
  console.error(
    `  Progress is not lost: every page fetched so far is saved in ` +
      `${outputDir}/.staging/${slug}.partial.jsonl -- rerun the same command to resume from where this left off.`
  );
  if (err instanceof HttpStatusError && (err.status === 401 || err.status === 403)) {
    console.error(
      `  Note: HTTP ${err.status} can mean your login session expired partway through this run. ` +
        `If rerunning hits the same error immediately, a fresh login (simply running the command again, ` +
        `since login always re-runs at the start) should resolve it -- if not, this may need a closer look.`
    );
  }
}

export default async function exportLibrary(options: ExportLibraryOptions): Promise<void> {
  const runStart = Date.now();
  console.log(`Run started at ${new Date(runStart).toISOString()}`);

  // Must be registered BEFORE puppeteer.launch() -- puppeteer-extra installs
  // a plugin's evasions onto the launch/page-creation hooks at launch time,
  // so calling .use() after a browser is already running silently disables
  // every stealth patch for that browser's pages (this was a real bug in an
  // earlier draft of this file: StealthPlugin() was registered after launch).
  puppeteer.use(StealthPlugin());

  await fs.promises.mkdir(options.outputDir, { recursive: true });

  const browser: Browser = await puppeteer.launch({
    // Authentication is interactive -- the user types the login code into the window.
    headless: false,
    protocolTimeout: 1_800_000,
    args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=4096"],
  });

  try {
    let page: Page = await browser.newPage();
    if (options.verbose) {
      page.on("console", (msg) => console.log(`  [browser] ${msg.text()}`));
    }

    await login(page, options.email, { verbose: options.verbose, screenshotDir: options.outputDir });

    const saver = new ConversationSaver(page, {
      outputDir: options.outputDir,
      doneFilePath: options.doneFilePath,
      verbose: options.verbose,
      pageLimit: options.pageLimit,
      rateLimitRetries: options.rateLimitRetries,
    });
    await saver.initialize();

    let recoveryCount = 0;
    const maxRecoveriesPerRun = 5;

    const recreatePage = async (reason: string): Promise<void> => {
      console.log(`  ↻ Recreating page (${reason})...`);
      try {
        await page.close();
      } catch {
        // already closed
      }
      page = await browser.newPage();
      if (options.verbose) {
        page.on("console", (msg) => console.log(`  [browser] ${msg.text()}`));
      }
      saver.setPage(page); // preserves pageFetchRecords/failedSlugs/doneFile, unlike constructing a new saver
      try {
        await page.goto("https://www.perplexity.ai/", { waitUntil: "domcontentloaded", timeout: 300_000 });
      } catch {
        // best-effort
      }
      await sleep(2000);
    };

    /** Runs `fn`, recovering once via recreatePage on a frame/session error,
     * up to maxRecoveriesPerRun times across the whole run. */
    const withFrameRecovery = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (isFrameError(message) && recoveryCount < maxRecoveriesPerRun) {
          recoveryCount += 1;
          console.error(`  Frame error (recovery ${recoveryCount}/${maxRecoveriesPerRun}): ${message}`);
          await recreatePage("frame error");
          return fn();
        }
        throw err;
      }
    };

    // --- Single-URL mode: -u/--url ------------------------------------------
    if (options.url) {
      console.log(`Single-URL mode: processing ${options.url} (skipping full library scan)`);
      const match = THREAD_UUID_RE.exec(options.url);
      const slug = match ? match[1] : options.url;
      // updatedAt is a placeholder until the thread is actually fetched --
      // this mode has no library-listing response to draw a real value
      // from. It's overwritten below with the thread's own latest
      // entry_updated_datetime before finalizeThread() writes it to
      // done.json, so a later full-library run can correctly recognize
      // this thread as already up to date and skip re-exporting it.
      const conversation: Conversation = {
        title: slug,
        url: options.url,
        slug,
        updatedAt: new Date().toISOString(),
      };
      if (saver.isAlreadyDone(slug)) {
        console.log(`  Note: ${slug} was already exported previously -- re-exporting as requested.`);
      }

      const passStart = Date.now();
      let processed = 0;
      try {
        let state = await withFrameRecovery(() => saver.startThread(conversation));
        while (!saver.isDone(state)) {
          state = await withFrameRecovery(() => saver.fetchNextPage(state));
        }
        // Replace the placeholder updatedAt with the thread's real latest
        // entry timestamp now that we've actually fetched it -- see the
        // comment on `conversation` above for why this matters.
        conversation.updatedAt = getLatestEntryUpdatedAt(state.entries);
        await saver.finalizeThread(state);
        processed = 1;
      } catch (err) {
        logFailureWithResumeHint(options.url, slug, options.outputDir, err);
        saver.failedSlugs.push(slug);
      }

      const stats = buildRunStats("single", passStart, saver.pageFetchRecords, saver.failedSlugs, saver.safetyCapSlugs, processed, 0);
      await writeRunStats(options.outputDir, options.doneFilePath, stats);
      await browser.close();
      console.log(`Done. Single-URL run finished in ${formatDuration(Date.now() - runStart)}.`);
      return;
    }

    // --- Full-library mode ---------------------------------------------------
    const conversations = await getConversations(page, saver.getDoneFileSnapshot());
    console.log(`Found ${conversations.length} new conversations to process`);

    // Pass 1 ("quick"): every new thread gets a bounded chance of up to
    // options.deferAfterPages pages. Anything that finishes within that
    // budget is written immediately. Anything still going is parked -- with
    // its fetched pages, offset, and adaptive-delay state intact -- into the
    // deferred queue, so pass 2 resumes rather than restarts it.
    const deferred: ThreadFetchState[] = [];
    let quickProcessed = 0;
    let successSinceRefresh = 0;
    const quickStart = Date.now();

    for (const conversation of conversations) {
      try {
        let state = await withFrameRecovery(() => saver.startThread(conversation));
        while (!saver.isDone(state) && state.pageIndex < options.deferAfterPages) {
          state = await withFrameRecovery(() => saver.fetchNextPage(state));
        }

        if (saver.isDone(state)) {
          await saver.finalizeThread(state);
          quickProcessed += 1;
          successSinceRefresh += 1;
        } else {
          if (options.verbose) {
            console.log(`[verbose] deferring ${conversation.slug} to pass 2 (still going after ${options.deferAfterPages} pages)`);
          }
          deferred.push(state);
        }
      } catch (err) {
        logFailureWithResumeHint(conversation.url, conversation.slug, options.outputDir, err);
        saver.failedSlugs.push(conversation.slug);
      }

      if (successSinceRefresh > 0 && successSinceRefresh % 50 === 0) {
        await recreatePage("periodic refresh");
      }
      await sleep(2000); // politeness gap between conversations, independent of the per-page adaptive delay
    }

    const quickStats = buildRunStats("quick", quickStart, saver.pageFetchRecords, saver.failedSlugs, saver.safetyCapSlugs, quickProcessed, deferred.length);
    await writeRunStats(options.outputDir, options.doneFilePath, quickStats);
    console.log(`Pass 1 (quick) done: ${quickProcessed} exported, ${deferred.length} deferred, ${saver.failedSlugs.length} failed so far.`);

    // Pass 2 ("deferred"): resume every parked thread to completion. Nothing
    // else is waiting behind them now, so a marathon thread no longer blocks
    // the rest of the run.
    const deferredRecordsStart = saver.pageFetchRecords.length;
    const deferredFailedStart = saver.failedSlugs.length;
    const deferredStart = Date.now();
    let deferredProcessed = 0;

    for (let state of deferred) {
      try {
        while (!saver.isDone(state)) {
          state = await withFrameRecovery(() => saver.fetchNextPage(state));
        }
        await saver.finalizeThread(state);
        deferredProcessed += 1;
        successSinceRefresh += 1;
      } catch (err) {
        logFailureWithResumeHint(state.conversation.url, state.conversation.slug, options.outputDir, err);
        saver.failedSlugs.push(state.conversation.slug);
      }

      if (successSinceRefresh > 0 && successSinceRefresh % 50 === 0) {
        await recreatePage("periodic refresh");
      }
    }

    const deferredStats = buildRunStats(
      "deferred",
      deferredStart,
      saver.pageFetchRecords.slice(deferredRecordsStart),
      saver.failedSlugs.slice(deferredFailedStart),
      saver.safetyCapSlugs,
      deferredProcessed,
      0
    );
    await writeRunStats(options.outputDir, options.doneFilePath, deferredStats);

    console.log(
      `Done in ${formatDuration(Date.now() - runStart)}. ` +
        `${quickProcessed + deferredProcessed} exported (${quickProcessed} quick, ${deferredProcessed} deferred), ` +
        `${saver.failedSlugs.length} failed. Recoveries used: ${recoveryCount}/${maxRecoveriesPerRun}.`
    );
  } catch (error) {
    console.error("An error occurred:", error);
  } finally {
    await browser.close();
  }
}
