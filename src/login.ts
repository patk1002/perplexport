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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function login(page: Page, email: string): Promise<void> {
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

  // DEBUG: see what's available now that sidebar (should be) open
  await page.screenshot({ path: "/home/patk1/debug2.png" });
  
  // Email input
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.type('input[type="email"]', email);

  // "Continue with email" button — text varies, try variants
  for (const sel of CONTINUE_BUTTON_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.click(sel);
      console.log(`Clicked continue via: ${sel}`);
      break;
    } catch {
      // try next selector
    }
  }

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
  console.log("  Polling /api/auth/session every 5s for up to 5 min...");
  console.log("==========================================================================");
  console.log("");

  // Source-of-truth login check: poll /api/auth/session for a valid user object.
  // DOM-based detection (e.g. waiting for #ask-input) is unreliable because
  // Perplexity renders the search UI to anonymous users too.
  const start = Date.now();
  const timeoutMs = 5 * 60 * 1000;
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
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.log(`  (session check interrupted, retrying: ${msg.split("\n")[0]})`);
      session = null;
    }
    if (session && session.user && session.user.email) {
      userEmail = session.user.email;
      break;
    }
    await sleep(5000);
  }
  if (!userEmail) {
    throw new Error(
      "Login timeout (5 min) — /api/auth/session never returned a user. " +
        "Did you type the CODE into the Puppeteer Chrome window? " +
        "(Clicking the magic link in the email logs in your regular browser instead.)"
    );
  }
  console.log(`Successfully logged in as ${userEmail}`);
}
