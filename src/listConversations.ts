import { Page } from "puppeteer";
import { Conversation, DoneFile } from "./types";

const GRAPHQL_URL = "https://www.perplexity.ai/rest/perplexity_ask/graphql";

const FIRST_PAGE_HASH =
  "1c1f9e86416eddf3dfed6ede99575a5cc241b59cf079f2e9295ed927f2908006";
const NEXT_PAGE_HASH =
  "e207cce86b2c9b67fca3ea7d8450d675ec86c0c429b38e42e88f3b027e7c8729";

interface RawThread {
  slug: string;
  name: string;
  updatedAt: string;
}

async function fetchGraphQL(
  page: Page,
  operationName: string,
  variables: Record<string, unknown>,
  sha256Hash: string,
): Promise<any> {
  return await page.evaluate(
    async (
      url: string,
      opName: string,
      vars: Record<string, unknown>,
      hash: string,
    ) => {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationName: opName,
          variables: vars,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
      });
      return res.json();
    },
    GRAPHQL_URL,
    operationName,
    variables,
    sha256Hash,
  );
}

export async function getConversations(
  page: Page,
  doneFile: DoneFile,
): Promise<Conversation[]> {
  console.log("Fetching library via GraphQL...");
  const all: RawThread[] = [];

  let result = await fetchGraphQL(
    page,
    "LibraryThreadsRelayQuery",
    {
      includeSearchPreview: false,
      searchTerm: null,
      sortOrder: "NEWEST",
      statuses: null,
      threadTypes: null,
      sources: null,
      includeTemporary: null,
    },
    FIRST_PAGE_HASH,
  );

  let threads = result?.data?.viewer?.recentGroup?.threads;
  if (!threads) {
    throw new Error("Could not fetch first page of library via GraphQL.");
  }

  for (const edge of threads.edges) all.push(edge.node);
  let cursor = threads.pageInfo.endCursor;
  let hasNextPage = threads.pageInfo.hasNextPage;

  while (hasNextPage) {
    console.log(`  Fetched ${all.length} so far, continuing...`);
    result = await fetchGraphQL(
      page,
      "LibraryRecentThreadsPaginationQuery",
      {
        count: 25,
        cursor,
        includeSearchPreview: false,
        includeTemporary: null,
        searchTerm: null,
        sortOrder: "NEWEST",
        sources: null,
        statuses: null,
        threadTypes: null,
      },
      NEXT_PAGE_HASH,
    );
    threads = result?.data?.viewer?.recentGroup?.threads;
    if (!threads) break;
    for (const edge of threads.edges) all.push(edge.node);
    cursor = threads.pageInfo.endCursor;
    hasNextPage = threads.pageInfo.hasNextPage;
  }

  console.log(`Found ${all.length} threads in library`);

  return all
    .map((t) => ({
      title: t.name || "Untitled",
      url: `https://www.perplexity.ai/search/${t.slug}`,
      slug: t.slug,
      updatedAt: t.updatedAt,
    }))
    .filter((c) => {
      const known = doneFile.processed[c.slug];
      return !known || known.updatedAt !== c.updatedAt;
    });
}
