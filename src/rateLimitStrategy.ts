/**
 * Rate-limit backoff strategy.
 *
 * Schedule (attempt -> wait): 30s / 60s / 120s / 240s / 300s / 300s / 300s
 * Base doubles each attempt, capped at RATE_LIMIT_MAX_WAIT_MS.
 * When the server supplies a Retry-After header, that value wins over the
 * computed exponential backoff.
 */

export const RATE_LIMIT_RETRIES = 7;
export const RATE_LIMIT_BASE_WAIT_MS = 30_000;
export const RATE_LIMIT_MAX_WAIT_MS = 300_000;

export class RateLimitError extends Error {
  constructor(message: string, public readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function computeBackoffMs(attempt: number): number {
  // attempt is 1-indexed
  const raw = RATE_LIMIT_BASE_WAIT_MS * Math.pow(2, attempt - 1);
  return Math.min(raw, RATE_LIMIT_MAX_WAIT_MS);
}

export function parseRetryAfter(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (!Number.isNaN(asSeconds)) return asSeconds * 1000;
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetryOptions {
  verbose?: boolean;
  label?: string;
}

/**
 * Runs `fn` with up to RATE_LIMIT_RETRIES attempts. Each attempt is its own
 * isolated call (e.g. a fresh page.evaluate), so a long cumulative retry
 * sequence never risks a single call exceeding Puppeteer's protocolTimeout.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { verbose = false, label = "request" } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= RATE_LIMIT_RETRIES + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof RateLimitError) || attempt > RATE_LIMIT_RETRIES) {
        throw err;
      }
      const waitMs = err.retryAfterMs ?? computeBackoffMs(attempt);
      if (verbose) {
        console.log(
          `[verbose] ${label}: rate limited (attempt ${attempt}/${RATE_LIMIT_RETRIES}), ` +
            `waiting ${Math.round(waitMs / 1000)}s before retry`
        );
      }
      await sleep(waitMs);
    }
  }

  throw lastError;
}
