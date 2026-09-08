/**
 * Lightweight unit tests for rateLimitStrategy.ts using Node's built-in test
 * runner (node:test) -- no extra devDependency required. Run after building:
 *
 *   npm run build && node --test dist/rateLimitStrategy.test.js
 *
 * rateLimitStrategy.ts is the one module with zero Puppeteer/filesystem
 * dependencies, making it the cheapest and highest-value thing to actually
 * test before leaning on it in other projects (e.g. LIMIT).
 *
 * The fetchWithTieredRetry tests inject an instant no-op via
 * TieredRetryContext.sleepFn -- without it, these tests would sleep for the
 * REAL 30s/60s/... backoff schedule (minutes of real wall-clock time per
 * test), since that schedule is correctly evidence-tuned for production,
 * not for a fast test suite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AdaptiveDelay,
  computeExponentialWaitMs,
  decideThrottle,
  fetchWithTieredRetry,
  parseQuotaHeaders,
  parseRetryAfter,
  RateLimitError,
  RATE_LIMIT_SCHEDULE_MS,
} from "./rateLimitStrategy";

const instantSleep = async (_ms: number): Promise<void> => {
  /* no-op: skips the real wait so retry-loop tests run in milliseconds */
};

test("parseRetryAfter: delay-seconds form", () => {
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter("0"), 0);
});

test("parseRetryAfter: HTTP-date form", () => {
  const future = new Date(Date.now() + 10_000).toUTCString();
  const waitMs = parseRetryAfter(future);
  assert.ok(waitMs !== null && waitMs > 9_000 && waitMs <= 10_000);
});

test("parseRetryAfter: past date, missing, or garbage all return null", () => {
  const past = new Date(Date.now() - 10_000).toUTCString();
  assert.equal(parseRetryAfter(past), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter("not-a-number-or-date"), null);
});

test("parseQuotaHeaders: IETF-draft RateLimit-* pair, case-insensitive", () => {
  const result = parseQuotaHeaders({
    "RateLimit-Remaining": "0",
    "ratelimit-reset": "15",
  });
  assert.deepEqual(result, { remaining: 0, resetMs: 15_000 });
});

test("parseQuotaHeaders: falls back to legacy X-RateLimit-* pair", () => {
  const result = parseQuotaHeaders({
    "X-RateLimit-Remaining": "2",
    "X-RateLimit-Reset": "5",
  });
  assert.deepEqual(result, { remaining: 2, resetMs: 5_000 });
});

test("parseQuotaHeaders: returns null when neither pair is present", () => {
  assert.equal(parseQuotaHeaders({ "content-type": "application/json" }), null);
});

test("computeExponentialWaitMs: matches the tuned schedule, then caps", () => {
  for (let attempt = 1; attempt <= RATE_LIMIT_SCHEDULE_MS.length; attempt++) {
    assert.equal(
      computeExponentialWaitMs(attempt),
      RATE_LIMIT_SCHEDULE_MS[attempt - 1],
    );
  }
  assert.equal(
    computeExponentialWaitMs(99),
    RATE_LIMIT_SCHEDULE_MS[RATE_LIMIT_SCHEDULE_MS.length - 1],
  );
});

test("AdaptiveDelay: jumps to proven wait, then decays toward zero", () => {
  const adaptive = new AdaptiveDelay();
  assert.equal(adaptive.value, 0);

  adaptive.registerThrottle(1000);
  assert.equal(adaptive.value, 1000);

  adaptive.registerThrottle(500); // lower proof shouldn't reduce an already-higher baseline
  assert.equal(adaptive.value, 1000);

  let previous = adaptive.value;
  let iterations = 0;
  while (adaptive.value > 0 && iterations < 100) {
    adaptive.registerSuccess();
    assert.ok(
      adaptive.value <= previous,
      "baseline must never increase on a clean response",
    );
    previous = adaptive.value;
    iterations += 1;
  }
  assert.equal(
    adaptive.value,
    0,
    "baseline should eventually floor to exactly zero",
  );
});

test("decideThrottle: tier 1 fires on any response with low remaining quota", () => {
  const adaptive = new AdaptiveDelay();
  const decision = decideThrottle(
    {
      status: 200,
      headers: { "RateLimit-Remaining": "1", "RateLimit-Reset": "20" },
    },
    1,
    adaptive,
  );
  assert.equal(decision.tier, "quota-header");
  assert.equal(decision.waitMs, 20_000);
});

test("decideThrottle: tier 2 fires on 429 with Retry-After, ignoring tier 3", () => {
  const adaptive = new AdaptiveDelay();
  const decision = decideThrottle(
    { status: 429, headers: { "retry-after": "45" } },
    1,
    adaptive,
  );
  assert.equal(decision.tier, "retry-after");
  assert.equal(decision.waitMs, 45_000);
});

test("decideThrottle: tier 3 fires on 429 with no rate-limit headers at all", () => {
  const adaptive = new AdaptiveDelay();
  const decision = decideThrottle({ status: 429, headers: {} }, 1, adaptive);
  assert.equal(decision.tier, "aimd");
  assert.equal(decision.waitMs, RATE_LIMIT_SCHEDULE_MS[0]);
});

test("decideThrottle: clean response with no headers decays the adaptive baseline", () => {
  const adaptive = new AdaptiveDelay();
  adaptive.registerThrottle(1000);
  const decision = decideThrottle({ status: 200, headers: {} }, 1, adaptive);
  assert.equal(decision.tier, "aimd");
  assert.ok(decision.waitMs < 1000 && decision.waitMs > 0);
});

test("fetchWithTieredRetry: retries through 429s with no headers, then succeeds", async () => {
  let calls = 0;
  const result = await fetchWithTieredRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        return { status: 429, headers: {}, bodyText: "" };
      }
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ ok: true }),
      };
    },
    (bodyText) => JSON.parse(bodyText) as { ok: boolean },
    { adaptive: new AdaptiveDelay(), maxRetries: 3, sleepFn: instantSleep },
  );

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.data, { ok: true });
});

test("fetchWithTieredRetry: throws RateLimitError once maxRetries is exhausted", async () => {
  await assert.rejects(
    () =>
      fetchWithTieredRetry(
        async () => ({ status: 429, headers: {}, bodyText: "" }),
        (bodyText) => bodyText,
        { adaptive: new AdaptiveDelay(), maxRetries: 2, sleepFn: instantSleep },
      ),
    RateLimitError,
  );
});

test("fetchWithTieredRetry: a non-retryable status throws immediately, not a RateLimitError", async () => {
  await assert.rejects(
    () =>
      fetchWithTieredRetry(
        async () => ({ status: 500, headers: {}, bodyText: "" }),
        (bodyText) => bodyText,
        { adaptive: new AdaptiveDelay(), maxRetries: 3, sleepFn: instantSleep },
      ),
    (err: unknown) => err instanceof Error && !(err instanceof RateLimitError),
  );
});
