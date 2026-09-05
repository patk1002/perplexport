import { promises as fs } from "fs";
import puppeteer from "puppeteer-extra";
import { Browser, Page } from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { ConversationSaver } from "./ConversationSaver";
import { getConversations } from "./listConversations";
import { login } from "./login";
import renderConversation from "./renderConversation";
import { loadDoneFile, saveDoneFile, sleep } from "./utils";

function formatLocalTimestamp(isoString: string, timeZone = "America/Chicago"): string {
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

function buildFilename(threadData: any, fallbackId: string): string {
  const entry = threadData.conversation?.entries?.[0];
  const title: string = entry?.thread_title || fallbackId;
  const updatedAt: string = entry?.entry_updated_datetime || "";
  const timestamp = updatedAt
    ? formatLocalTimestamp(updatedAt)
    : formatLocalTimestamp(new Date().toISOString());

  const safeTitle = title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);

  return `${timestamp} ${safeTitle}`;
}

export interface ExportLibraryOptions {
  outputDir: string;
  doneFilePath: string;
  email: string;
}

export default async function exportLibrary(options: ExportLibraryOptions) {
  puppeteer.use(StealthPlugin());

  await fs.mkdir(options.outputDir, { recursive: true });

  const doneFile = await loadDoneFile(options.doneFilePath);
  console.log(`Loaded ${Object.keys(doneFile.processed).length} processed URLs from done file`);

  const browser: Browser = await puppeteer.launch({
    // Authentication is interactive — user types the login code into the window.
    headless: false,
    protocolTimeout: 1800000,
    args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=4096"],

  });

  try {
    let page: Page = await browser.newPage();

    await login(page, options.email);
    const conversations = await getConversations(page, doneFile);

    console.log(`Found ${conversations.length} new conversations to process`);

    let conversationSaver = new ConversationSaver(page);
    await conversationSaver.initialize();

    // Page-recreation recovery — if the page detaches mid-run (Chromium
    // tab crash, navigation issue), recreate it. Cookies persist on the
    // browser context so no re-login is needed.
    const recreatePage = async (reason: string): Promise<void> => {
      console.log(`  ↻ Recreating page (${reason})...`);
      try { await page.close(); } catch { /* already closed */ }
      page = await browser.newPage();
      conversationSaver = new ConversationSaver(page);
      await conversationSaver.initialize();
      try {
        await page.goto("https://www.perplexity.ai/", { waitUntil: "domcontentloaded", timeout: 300000 });
      } catch { /* best-effort */ }
      await sleep(2000);
    };

    let okCount = 0;
    let failCount = 0;
    let recoveryCount = 0;
    const maxRecoveriesPerRun = 5;

    for (const conversation of conversations) {
      console.log(`Processing conversation ${conversation.url}`);
      let attempt = 0;
      const maxAttempts = 2;
      while (attempt < maxAttempts) {
        attempt += 1;

        try {
          const threadData = await conversationSaver.loadThreadFromURL(conversation.url);
          const filename = buildFilename(threadData, threadData.id);

          const previous = doneFile.processed[conversation.slug];
          if (previous?.filename && previous.filename !== filename) {
            for (const ext of [".json", ".md"]) {
              try {
                await fs.unlink(`${options.outputDir}/${previous.filename}${ext}`);
              } catch {
                // old file may not exist; ignore
              }
            }
          }

          await fs.writeFile(
            `${options.outputDir}/${filename}.json`,
            JSON.stringify(threadData.conversation, null, 2)
          );

          let markdown: string;
          try {
            markdown = renderConversation(threadData.conversation);
          } catch (renderErr: any) {
            console.error(`  Render failed (saving JSON only): ${renderErr.message}`);
            markdown = `# Render error\n\nSee ${filename}.json for raw data.\n\nError: ${renderErr.message}\n`;
          }
          await fs.writeFile(`${options.outputDir}/${filename}.md`, markdown);

          doneFile.processed[conversation.slug] = {
            updatedAt: conversation.updatedAt,
            filename,
          };
          await saveDoneFile(doneFile, options.doneFilePath);
          okCount += 1;
          break;
        } catch (err: any) {
          const msg: string = err.message || String(err);
          const isFrameError =
            msg.includes("detached Frame") ||
            msg.includes("Target closed") ||
            msg.includes("Session closed") ||
            msg.includes("Protocol error") ||
            msg.includes("Runtime.callFunctionOn timed out");
          if (isFrameError && attempt < maxAttempts && recoveryCount < maxRecoveriesPerRun) {
            recoveryCount += 1;
            console.error(`  Frame error (attempt ${attempt}/${maxAttempts}, recovery ${recoveryCount}/${maxRecoveriesPerRun}): ${msg}`);
            await recreatePage("frame error");
            continue;
          }
          console.error(`  FAILED ${conversation.url}: ${msg}`);
          failCount += 1;
          break;
        }
      }
      if (okCount > 0 && okCount % 50 === 0) {
        await recreatePage("periodic refresh");
      }
      await sleep(2000); // be polite
    }
    console.log(`Done. Processed: ${okCount} OK, ${failCount} failed. Recoveries used: ${recoveryCount}/${maxRecoveriesPerRun}`);
  } catch (error) {
    console.error("An error occurred:", error);
  } finally {
    await browser.close();
  }
}
