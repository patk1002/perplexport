/**
 * rateLimitStrategy.ts
 *
 * Framework-agnostic, three-tier rate-limit handling. Zero dependencies on
 * Puppeteer, Node-specific APIs, or perplexport itself -- every function
 * takes plain data (status codes, header maps, numbers) and returns plain
 * data, so this file can be copied as-is into other projects (e.g. LIMIT's
 * shopping/trading automation) and pointed at a native `fetch` response.
 *
 * Priority order, re-evaluated fresh on every single response (never a
 * one-time upfront probe, since the same endpoint can behave differently
 * under different load):
 *
 *   1. RateLimit-Remaining / RateLimit-Reset (IETF draft-ietf-httpapi-
 *      ratelimit-headers) or the legacy X-RateLimit-Remaining / X-RateLimit-
 *      Reset -- if present, proactively throttle from remaining quota
 *      BEFORE a 429 ever happens.
 *   2. Retry-After on an actual 429/503 -- authoritative and reactive; use
 *      it exactly as the server specifies.
 *   3. AIMD-style fallback -- used only when neither header is present.
 *      Combines an adaptive baseline delay (jumps to a proven-necessary
 *      wait the instant throttling is observed, decays gently on clean
 *      responses) with a fixed 30/60/120/240/300/300/300s schedule as a
 *      hard backstop for the retry-count itself.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of retry attempts permitted after the first attempt fails
 * with a 429/503. Callers may override per-call via TieredRetryContext.maxRetries. */
export const RATE_LIMIT_RETRIES = 7;

/** Fixed exponential-with-cap schedule, indexed by attempt (1-indexed). */
export const RATE_LIMIT_SCHEDULE_MS = [
  30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
] as const;

export const RATE_LIMIT_MAX_WAIT_MS = 300_000;

/** Below this, an adaptive baseline delay is treated as "no meaningful wait." */
const ADAPTIVE_FLOOR_MS = 250;

/** Multiplicative decay applied to the adaptive baseline after each clean response. */
const ADAPTIVE_DECAY_FACTOR = 0.85;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The bare, serializable shape of an HTTP response -- safe to pass across a
 * Puppeteer `page.evaluate` boundary, since it contains only plain data. */
export interface RawFetchResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export type ThrottleTier = "quota-header" | "retry-after" | "aimd";

export interface ThrottleDecision {
  tier: ThrottleTier;
  waitMs: number;
  detail: string;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Header parsing (tiers 1 and 2)
// ---------------------------------------------------------------------------

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** Case-insensitive header lookup over a plain object (headers cross the
 * Puppeteer boundary as a plain object, not a real `Headers` instance). */
function getHeader(
  headers: Record<string, string>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

/**
 * Tier 2: parses RFC 9110 `Retry-After` -- either `delay-seconds` (a plain
 * integer) or an HTTP-date. Returns milliseconds to wait, or null if the
 * header is absent/unparseable.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
): number | null {
  if (!headerValue) return null;
  const asSeconds = toNumber(headerValue);
  if (asSeconds !== null) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}

/**
 * Tier 1: checks the IETF-draft `RateLimit-Remaining` / `RateLimit-Reset`
 * pair, falling back to the legacy `X-RateLimit-Remaining` / `X-RateLimit-
 * Reset` pair used by GitHub and many other API providers. Note: this does
 * NOT parse the newer combined single-header form (`RateLimit: limit=100;
 * remaining=5; reset=30`) -- that's a reasonable future addition if a
 * target site uses it, but neither header form is expected to appear on
 * Perplexity's internal, unpublished endpoint.
 */
export function parseQuotaHeaders(
  headers: Record<string, string>,
): { remaining: number; resetMs: number } | null {
  const remaining =
    toNumber(getHeader(headers, "RateLimit-Remaining")) ??
    toNumber(getHeader(headers, "X-RateLimit-Remaining"));
  const resetSeconds =
    toNumber(getHeader(headers, "RateLimit-Reset")) ??
    toNumber(getHeader(headers, "X-RateLimit-Reset"));

  if (remaining === null || resetSeconds === null) return null;
  return { remaining, resetMs: Math.max(0, resetSeconds * 1000) };
}

/** Tier 3 (part A): the fixed, evidence-based backoff schedule. `attempt` is 1-indexed. */
export function computeExponentialWaitMs(attempt: number): number {
  const index = Math.min(attempt - 1, RATE_LIMIT_SCHEDULE_MS.length - 1);
  return RATE_LIMIT_SCHEDULE_MS[Math.max(0, index)];
}

// ---------------------------------------------------------------------------
// Tier 3 (part B): adaptive AIMD-style baseline delay
// ---------------------------------------------------------------------------

/**
 * Tracks a proactive, between-request baseline delay. On any throttling
 * signal it jumps straight to the proven-necessary wait (additive
 * increase against evidence, not a guess); on clean responses it decays
 * gently (multiplicative decrease) rather than snapping back to zero,
 * since a clean response is not strong evidence the cooldown has fully
 * lifted. This is what lets the client avoid re-discovering the same
 * threshold from scratch on every single request.
 *
 * Scope note: this class holds state for exactly one "bucket." Whether
 * that bucket should be shared across an entire run (recommended default
 * -- matches observed account/session-scoped throttling on Perplexity's
 * internal endpoint, and documented seller/account-level scoping on
 * Amazon SP-API and the Walmart Marketplace API) or split per-host/
 * per-resource is a decision for the caller: construct one instance per
 * desired scope.
 */
export class AdaptiveDelay {
  private currentMs = 0;

  /** Current baseline delay to apply before the next request. */
  get value(): number {
    return this.currentMs;
  }

  /** Call when a response indicates throttling (a 429/503, or a low-quota tier-1 signal). */
  registerThrottle(provenWaitMs: number): void {
    this.currentMs = Math.max(this.currentMs, provenWaitMs);
  }

  /** Call on every clean (non-throttled) response to decay the baseline. */
  registerSuccess(): void {
    const decayed = this.currentMs * ADAPTIVE_DECAY_FACTOR;
    this.currentMs = decayed < ADAPTIVE_FLOOR_MS ? 0 : decayed;
  }
}

// ---------------------------------------------------------------------------
// Unified decision function -- checked fresh on every response
// ---------------------------------------------------------------------------

/**
 * Decides how long to wait before the *next* request, given the response
 * that was just received. Called for every response, success or failure,
 * so a target site changing its rate-limit approach over time (or a single
 * endpoint behaving inconsistently under load) requires no code changes to
 * adapt to.
 */
export function decideThrottle(
  signal: { status: number; headers: Record<string, string> },
  attempt: number,
  adaptive: AdaptiveDelay,
): ThrottleDecision {
  const quota = parseQuotaHeaders(signal.headers);
  const isThrottled = signal.status === 429 || signal.status === 503;

  // Tier 1: proactive quota headers, checked regardless of status code.
  if (quota && quota.remaining <= 1) {
    adaptive.registerThrottle(quota.resetMs);
    return {
      tier: "quota-header",
      waitMs: quota.resetMs,
      detail: `remaining=${quota.remaining}`,
    };
  }

  if (!isThrottled) {
    adaptive.registerSuccess();
    return {
      tier: "aimd",
      waitMs: adaptive.value,
      detail: "clean response, decaying baseline",
    };
  }

  // Tier 2: authoritative Retry-After on an actual 429/503.
  const retryAfterMs = parseRetryAfter(
    getHeader(signal.headers, "Retry-After"),
  );
  if (retryAfterMs !== null) {
    adaptive.registerThrottle(retryAfterMs);
    return {
      tier: "retry-after",
      waitMs: retryAfterMs,
      detail: "server Retry-After header",
    };
  }

  // Tier 3: neither header present -- fixed schedule, floored by the
  // adaptive baseline in case it already proved a longer wait is needed.
  const scheduled = computeExponentialWaitMs(attempt);
  adaptive.registerThrottle(scheduled);
  return {
    tier: "aimd",
    waitMs: Math.max(scheduled, adaptive.value),
    detail: `attempt ${attempt}, no rate-limit headers present`,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TieredRetryContext {
  verbose?: boolean;
  label?: string;
  adaptive: AdaptiveDelay;
  /** Overrides RATE_LIMIT_RETRIES for this call. Useful for a CLI-exposed
   * --rate-limit-retries flag without changing this module's own default. */
  maxRetries?: number;
  /** Testability seam only -- defaults to the real setTimeout-based sleep.
   * Unit tests inject an instant resolver here to avoid real-time waits on
   * the (correctly) minutes-long production backoff schedule; production
   * callers should never set this. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface TieredRetryResult<T> {
  data: T;
  waitedMs: number;
  attempts: number;
  tier: ThrottleTier;
}

/**
 * Runs `rawFetch` (which must do ONLY the bare network request and return
 * plain, serializable status/headers/body data -- e.g. a single, isolated
 * `page.evaluate` call) up to maxRetries+1 times, applying the three-tier
 * decision on every response. Because each attempt is its own call to
 * `rawFetch`, no single external call (Puppeteer's protocolTimeout, an HTTP
 * client timeout, a DB driver timeout) ever has to contain the full retry
 * loop -- the loop and all its waits live here in plain TypeScript.
 */
export async function fetchWithTieredRetry<T>(
  rawFetch: () => Promise<RawFetchResult>,
  parseBody: (bodyText: string) => T,
  ctx: TieredRetryContext,
): Promise<TieredRetryResult<T>> {
  const { verbose = false, label = "request" } = ctx;
  const maxRetries = ctx.maxRetries ?? RATE_LIMIT_RETRIES;
  const doSleep = ctx.sleepFn ?? sleep;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await rawFetch();

    if (result.status >= 200 && result.status < 300) {
      const decision = decideThrottle(result, attempt, ctx.adaptive);
      if (verbose) {
        console.log(
          `[verbose] ${label}: ok (tier=${decision.tier}, next delay ${Math.round(decision.waitMs / 1000)}s -- ${decision.detail})`,
        );
      }
      if (decision.waitMs > 0) await doSleep(decision.waitMs);
      return {
        data: parseBody(result.bodyText),
        waitedMs: decision.waitMs,
        attempts: attempt,
        tier: decision.tier,
      };
    }

    if (result.status === 429 || result.status === 503) {
      if (attempt > maxRetries) {
        throw new RateLimitError(
          `Exhausted ${maxRetries} retries (last status ${result.status}) for ${label}`,
        );
      }
      const decision = decideThrottle(result, attempt, ctx.adaptive);
      if (verbose) {
        console.log(
          `[verbose] ${label}: rate limited (attempt ${attempt}/${maxRetries}, tier=${decision.tier}), ` +
            `waiting ${Math.round(decision.waitMs / 1000)}s -- ${decision.detail}`,
        );
      }
      await doSleep(decision.waitMs);
      continue;
    }

    // Any other non-2xx status is not retryable by this module.
    throw new Error(`Request failed: HTTP ${result.status} for ${label}`);
  }

  throw new RateLimitError(`Exhausted retries for ${label}`, null);
}
