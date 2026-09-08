#!/usr/bin/env node
import { Command } from "commander";
import {
  DEFAULT_DEFER_AFTER_PAGES,
  DEFAULT_PAGE_LIMIT,
} from "./ConversationSaver";
import { RATE_LIMIT_RETRIES } from "./rateLimitStrategy";
import exportLibrary from "./exportLibrary";

function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

const program = new Command();

program
  .name("perplexport")
  .description("Export Perplexity conversations as JSON + Markdown files")
  .option(
    "-o, --output <dir>",
    "Output directory for exported conversations",
    "./conversations",
  )
  .option(
    "-d, --done-file <file>",
    "Done file location (tracks which URLs have been downloaded before)",
    "done.json",
  )
  .option(
    "-v, --verbose",
    "Enable verbose logging (browser console output, per-page fetch timing, rate-limit tier decisions)",
    false,
  )
  .option(
    "-u, --url <url>",
    "Process exactly one thread URL, skipping the full library scan (done.json is still read and updated for that thread)",
  )
  .option(
    "--page-limit <n>",
    "Entries fetched per API page",
    parseIntOption,
    DEFAULT_PAGE_LIMIT,
  )
  .option(
    "--defer-after-pages <n>",
    "Pages after which a still-fetching thread is parked for a second pass, so it can't block smaller threads",
    parseIntOption,
    DEFAULT_DEFER_AFTER_PAGES,
  )
  .option(
    "--rate-limit-retries <n>",
    "Max retries for a page fetch that keeps getting rate-limited",
    parseIntOption,
    RATE_LIMIT_RETRIES,
  )
  .requiredOption("-e, --email <email>", "Perplexity email")
  .parse();

async function main(): Promise<void> {
  const options = program.opts();
  await exportLibrary({
    outputDir: options.output,
    doneFilePath: options.doneFile,
    email: options.email,
    verbose: Boolean(options.verbose),
    url: options.url,
    pageLimit: options.pageLimit,
    deferAfterPages: options.deferAfterPages,
    rateLimitRetries: options.rateLimitRetries,
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
