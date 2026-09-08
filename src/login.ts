import fs from "fs";
import path from "path";
import { Page } from "puppeteer";

const COOKIE_BANNER_SELECTORS = [
  "button::-p-text('Got it')",
  "button::-p-text('Decline optional')",
  "button::-p-text('Accept All Cookies')",
  "button::-p-text('Accept All')",
  "button::-p-text('Accept all')",
  "button::-p-text('Accept')",
  "button::-p-text('I agree')",
  "button::-p-text('Souhlasím')",
  "button::-p-text('Přijmout vše')",
  "button::-p-text('Přijmout všechny')",
];

const CONTINUE_BUTTON_SELECTORS = [
  "button::-p-text('Continue with email')",
  "button::-p-text('Continue with Email')",
  "button::-p-text('Continue')",
  "button::-p-text('Pokračovat')",
];

/**
 * Best-effort click for a possible second-step "Sign In" button that may
 * appear on an interstitial screen after "Continue with email" -- observed
 * 2026-09-08: the automated flow stopped at "Continue with email" and the
 * 6-digit code field only appeared after a MANUAL "Sign In" click. Not
 * confirmed against the real current DOM (no selector guessed blindly);
 * this list is tried the same tolerant way as the other selector lists --
 * if none match, this is a no-op and behavior is unchanged from before.
 */
const SIGN_IN_SELECTORS = [
  "button::-p-text('Sign In')",
  "button::-p-text('Sign in')",
  "button::-p-text('Sign in with email')",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LoginOptions {
  verbose?: boolean;
  /** Screenshots are written to <screenshotDir>/.debug-login/, only when
   * verbose is true. Pass the run's outputDir -- never a hardcoded path. */
  screenshotDir?: string;
}

/** Tries each selector in order with a short timeout; clicks and returns
 * true on the first match, or logs an explicit warning and returns false if
 * none match -- a selector list finding nothing is a real signal the UI may
 * have changed, and should never fail silently. */
async function tryClickAny(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  label: string
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: timeoutMs });
      await page.click(sel);
      console.log(`${label} via: ${sel}`);
      return true;
    } catch {
      // try next selector
    }
  }
  console.log(`  WARNING: no ${label.toLowerCase()} selector matched -- the login UI may have changed.`);
  return false;
}

export async function login(page: Page, email: string, options: LoginOptions = {}): Promise<void> {
  const { verbose = false, screenshotDir } = options;
  let screenshotStep = 0;

  const snapshot = async (label: string): Promise<void> => {
    if (!verbose || !screenshotDir) return;
    const dir = path.join(screenshotDir, ".debug-login");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    screenshotStep += 1;
    const file = path.join(dir, `${String(screenshotStep).padStart(2, "0")}-${label}.png`);
    try {
      await page.screenshot({ path: file as `${string}.png` });
      console.log(`  [verbose] saved login screenshot: ${file}`);
    } catch (err) {
      console.log(`  [verbose] could not save login screenshot (${label}): ${(err as Error).message}`);
    }
  };

  console.log("Navigating to Perplexity...");
  await page.goto("https://www.perplexity.ai/");

  // Cookie banner — best-effort. Perplexity changes banner text/locale; if no
  // selector matches, login still works because the banner doesn't block focus.
  for (const sel of COOKIE_BANNER_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 2500 });
      await page.click(sel);
      console.log(`Dismissed cookie banner via: ${sel}`);
      break;
    } catch {
      // try next selector
    }
  }

  // Sidebar is collapsed by default; the sign-in trigger likely lives inside it.
  try {
    await page.waitForSelector('button[aria-label="Open sidebar"]', { timeout: 5000 });
    await page.click('button[aria-label="Open sidebar"]');
    console.log("Opened sidebar");
    await sleep(1500);
  } catch {
    console.log("Sidebar toggle not found or already open");
  }

  await snapshot("before-email");

  // Email input
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.type('input[type="email"]', email);

  await snapshot("email-typed");

  // "Continue with email" button — text varies, try variants
  await tryClickAny(page, CONTINUE_BUTTON_SELECTORS, 5000, "Clicked continue");

  await snapshot("after-continue-click");

  // Possible second-step "Sign In" button on an interstitial screen -- see
  // SIGN_IN_SELECTORS comment above. No-op if this step doesn't exist.
  await tryClickAny(page, SIGN_IN_SELECTORS, 5000, "Clicked sign-in");

  await snapshot("after-sign-in-click");

  console.log("");
  console.log("==========================================================================");
  console.log("MANUAL STEP: complete login in the Puppeteer-opened Chrome window.");
  console.log("");
  console.log("  Check your email for a Perplexity login email. It contains:");
  console.log("    * a 6-digit CODE   <-- USE THIS");
  console.log("    * a magic-link button ('Sign in')   <-- DO NOT click this");
  console.log("");
  console.log("  TYPE THE CODE into the Perplexity login UI in the Chrome window");
  console.log("  this script just opened. Clicking the magic link in the email would");
  console.log("  log in your *regular* browser, NOT this Puppeteer-controlled one,");
  console.log("  and the script would never see a valid session.");
  console.log("");
  console.log("  If more than one login email arrived, use the CODE from the MOST");
  console.log("  RECENT one -- an earlier code is invalidated once a new one is issued.");
  console.log("");
  console.log("  Polling /api/auth/session every 5s for up to 5 min...");
  console.log("==========================================================================");
  console.log("");

  await snapshot("polling-start");

  // Source-of-truth login check: poll /api/auth/session for a valid user object.
  // DOM-based detection (e.g. waiting for #ask-input) is unreliable because
  // Perplexity renders the search UI to anonymous users too.
  const start = Date.now();
  const timeoutMs = 5 * 60 * 1000;
  const heartbeatMs = 30 * 1000;
  let lastHeartbeat = start;
  let userEmail: string | null = null;
  while (Date.now() - start < timeoutMs) {
    let session: { user?: { email?: string } } | null = null;
    try {
      session = await page.evaluate(async () => {
        try {
          const r = await fetch("/api/auth/session", {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (!r.ok) return null;
          return (await r.json()) as { user?: { email?: string } } | null;
        } catch {
          return null;
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  (session check interrupted, retrying: ${msg.split("\n")[0]})`);
      session = null;
    }
    if (session && session.user && session.user.email) {
      userEmail = session.user.email;
      break;
    }
    if (Date.now() - lastHeartbeat >= heartbeatMs) {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      const totalSec = Math.round(timeoutMs / 1000);
      console.log(`  Still waiting for login... (${elapsedSec}s / ${totalSec}s)`);
      lastHeartbeat = Date.now();
    }
    await sleep(5000);
  }
  if (!userEmail) {
    await snapshot("login-timeout");
    throw new Error(
      "Login timeout (5 min) — /api/auth/session never returned a user. " +
        "Did you type the CODE into the Puppeteer Chrome window? " +
        "(Clicking the magic link in the email logs in your regular browser instead.)"
    );
  }
  console.log(`Successfully logged in as ${userEmail}`);
}
