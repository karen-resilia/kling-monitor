// Kling.ai Credit Monitor
// Posts credit balance to Slack every 2 hours.
// Adds escalating alerts based on credit thresholds.
//
// FIX v1 (2026-06-06): Added isAlreadyLoggedIn() check to handle the case
// where Kling loads the dashboard directly (no login form shown).
//
// FIX v2 (2026-06-06): isAlreadyLoggedIn() was called BEFORE dismissAllModals(),
// so the promo modal overlay was blocking the sidebar selectors from being found,
// causing the check to return false even on an authenticated session.
// The fix: call isAlreadyLoggedIn() AFTER dismissAllModals() completes.
// Also: made the logged-in check more robust — it now checks the page URL,
// page text content, and DOM simultaneously so a single blocked selector
// can't cause a false negative.

import { chromium } from 'playwright';
import * as dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  threshold: parseInt(process.env.CREDIT_THRESHOLD || '100'),
  hourlyThreshold: parseInt(process.env.HOURLY_THRESHOLD || '8000'),
  slackChannel: process.env.SLACK_CHANNEL || '#production-credits-monitor',
  teamName: process.env.TEAM_NAME || 'the team',
  klingEmail: process.env.KLING_EMAIL,
  klingPassword: process.env.KLING_PASSWORD,
  headless: process.env.HEADLESS !== 'false',
  hourlyMode: process.env.HOURLY_MODE === 'true',
  // Set DEBUG_SLACK_USER to a Slack user ID (e.g. "U012AB3CD") to send all
  // alerts as a DM to that person only, bypassing the channel entirely.
  // Remove or leave blank to resume normal channel posting.
  debugSlackUser: process.env.DEBUG_SLACK_USER || '',
};

// ---------------------------------------------------------------------------
// Modal dismissal — three-layer approach:
// 1. Try clicking close buttons via selectors + pixel coords
// 2. If that fails, forcibly REMOVE modal elements from the DOM entirely
// 3. Log every button considered so we can see exactly what's happening
// ---------------------------------------------------------------------------
async function dismissAllModals(page) {
  console.log('Dismissing modals...');

  // Layer 1a: Escape key
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  // Layer 1b: Pixel-accurate clicks on both known modal X positions
  // Anniversary modal X: (793, 227)  |  Trial Package modal X: (1247, 50)
  for (const [x, y] of [[1247, 50], [793, 227]]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(600);
  }

  // Layer 1c: Selector-based clicks
  const closeSelectors = [
    '[aria-label="close" i]',
    '[aria-label="Close"]',
    '[aria-label="dismiss" i]',
    '[class*="closeBtn"]',
    '[class*="close-btn"]',
    '[class*="closeButton"]',
    '[class*="close_btn"]',
    '[class*="modal-close"]',
    '[class*="popup-close"]',
  ];
  for (const sel of closeSelectors) {
    try {
      await page.click(sel, { timeout: 600, force: true });
      console.log('Selector click: ' + sel);
      await page.waitForTimeout(500);
    } catch { /* not present */ }
  }

  // Layer 2: Nuclear DOM removal — find and remove all modal/overlay containers.
  // This is a guaranteed kill regardless of click handling.
  const removed = await page.evaluate(() => {
    const removed = [];
    // Target elements that look like modal overlays
    const candidates = document.querySelectorAll([
      '[class*="modal" i]',
      '[class*="overlay" i]',
      '[class*="popup" i]',
      '[class*="dialog" i]',
      '[class*="toast" i]',
      '[role="dialog"]',
      '[role="alertdialog"]',
    ].join(','));

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      // Only remove elements that are actually visible and floating (fixed/absolute)
      if (
        rect.width > 100 &&
        rect.height > 50 &&
        (style.position === 'fixed' || style.position === 'absolute') &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      ) {
        removed.push(el.className.slice(0, 60));
        el.remove();
      }
    }
    return removed;
  });

  if (removed.length > 0) {
    console.log('DOM-removed ' + removed.length + ' overlay element(s): ' + removed.join(' | '));
  }

  // Also remove any backdrop/dimmer elements left behind
  await page.evaluate(() => {
    document.querySelectorAll('[class*="mask" i], [class*="backdrop" i], [class*="dimmer" i]').forEach(el => {
      const s = window.getComputedStyle(el);
      if (s.position === 'fixed' || s.position === 'absolute') el.remove();
    });
  });

  await page.waitForTimeout(400);
  console.log('Modal dismissal complete.');
}

// ---------------------------------------------------------------------------
// Detect whether we're on the authenticated dashboard.
// Uses THREE independent signals — any one is sufficient.
// Called AFTER dismissAllModals() so overlays don't interfere.
// ---------------------------------------------------------------------------
async function isAlreadyLoggedIn(page) {
  // Signal 1: URL — authenticated app pages always contain /app
  const url = page.url();
  console.log('Current URL: ' + url);
  if (url.includes('/app') && !url.includes('/login') && !url.includes('/signin')) {
    // Signal 2: Body text contains nav items that only exist when logged in
    const bodyText = await page.evaluate(() => document.body.innerText);
    const dashboardKeywords = ['Image Generation', 'Video Generation', 'Explore', 'All Tools', 'Generate'];
    const matchCount = dashboardKeywords.filter(kw => bodyText.includes(kw)).length;
    console.log('Dashboard keyword matches: ' + matchCount + '/' + dashboardKeywords.length);
    if (matchCount >= 2) {
      console.log('Logged-in check: PASS (URL + body text)');
      return true;
    }
  }

  // Signal 3: DOM selector fallback
  const domSelectors = [
    '[class*="sidebar"]',
    '[class*="nav-item"]',
    '[class*="user-avatar"]',
    '[class*="userAvatar"]',
    '[class*="profile"]',
  ];
  for (const sel of domSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 1500 });
      console.log('Logged-in check: PASS (DOM: ' + sel + ')');
      return true;
    } catch { continue; }
  }

  console.log('Logged-in check: FAIL — no signals matched');
  return false;
}

// ---------------------------------------------------------------------------
// Full login flow (only runs when not already authenticated)
// ---------------------------------------------------------------------------
async function performLogin(page) {
  console.log('Not logged in — performing login...');

  // Entry points for the login modal trigger button
  const loginEntryPoints = [
    'button:has-text("Sign In to Claim Gift")',
    'a:has-text("Sign In to Claim Gift")',
    'button:has-text("Join Now!")',
    'a:has-text("Join Now!")',
    'button:has-text("Sign In")',
    'a:has-text("Sign In")',
    'text="Sign in"',
    'a[href*="login"]',
    'a[href*="signin"]',
  ];

  let entryFound = false;
  for (const sel of loginEntryPoints) {
    try {
      await page.click(sel, { timeout: 3000 });
      console.log('Clicked login entry: ' + sel);
      entryFound = true;
      await page.waitForTimeout(2000);
      break;
    } catch { continue; }
  }

  if (!entryFound) {
    const els = await page.evaluate(() =>
      [...document.querySelectorAll('a, button')]
        .map(e => e.innerText.trim())
        .filter(t => t)
        .slice(0, 40)
        .join(' | ')
    );
    console.log('Clickable elements on page: ' + els);
    throw new Error('Could not find any login entry point on the page');
  }

  await page.screenshot({ path: 'ss3-login-modal.png' });

  // Click "Sign in with email" inside the modal
  await page.click('text="Sign in with email"', { timeout: 10000 });
  console.log('Clicked Sign in with email');

  await page.waitForSelector(
    'input[placeholder="Enter Email Address"], input[type="email"]',
    { timeout: 10000 }
  );
  console.log('Email input appeared');

  await page.fill('input[placeholder="Enter Email Address"], input[type="email"]', CONFIG.klingEmail);
  console.log('Filled email');
  await page.waitForTimeout(500);

  await page.fill('input[placeholder="Password"], input[type="password"]', CONFIG.klingPassword);
  console.log('Filled password');
  await page.waitForTimeout(500);

  // Submit — avoid clicking social-login buttons by excluding their text
  await page.click(
    'button:has-text("Sign In"):not(:has-text("with")):not(:has-text("Google")):not(:has-text("Apple")), button[type="submit"]'
  );
  console.log('Clicked Sign In button');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'ss4-after-login.png' });
}

// ---------------------------------------------------------------------------
// Main entry point — logs in via browser, then calls Kling's API directly
// using the authenticated session cookies to get credit balance.
// ---------------------------------------------------------------------------
async function checkKlingCredits() {
  console.log('Checking Kling.ai credits...');

  if (!CONFIG.klingEmail || !CONFIG.klingPassword) {
    throw new Error('Missing KLING_EMAIL or KLING_PASSWORD in .env file');
  }

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });

  // Intercept ALL JSON API responses — log them all so we can find the
  // credit endpoint, and capture any credit values we see along the way.
  let creditsFromApi = null;
  const seenApis = [];

  context.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('kling.ai') && !url.includes('klingai') &&
        !url.includes('kuaishou') && !url.includes('kwai')) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      const body = await response.json().catch(() => null);
      if (!body) return;
      const bodyStr = JSON.stringify(body).slice(0, 300);
      seenApis.push(url.split('?')[0]); // log base URL without query params
      // Look for credit data in every API response
      const found = findCreditsInObject(body);
      if (found !== null && creditsFromApi === null) {
        console.log('API credit hit: ' + url.split('?')[0] + ' → ' + found);
        creditsFromApi = found;
      }
    } catch { /* ignore */ }
  });

  try {
    // ── 1. Load the app ────────────────────────────────────────────────────
    await page.goto('https://kling.ai/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'ss1-initial.png' });

    // ── 2. Check login status via the API (not DOM — DOM is public) ─────────
    const loginStatus = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/user/isLogin', { credentials: 'include' });
        const j = await r.json();
        return j?.data?.login === true;
      } catch { return false; }
    });
    console.log('API login check: ' + loginStatus);

    // ── 3. Dismiss modals then login if needed ─────────────────────────────
    await dismissAllModals(page);
    await page.screenshot({ path: 'ss2-after-dismiss.png' });

    if (!loginStatus) {
      console.log('Not logged in — performing login...');
      await performLogin(page);
      await dismissAllModals(page);
      await page.waitForTimeout(2000);
    } else {
      console.log('Already logged in via API check.');
    }

    // ── 4. Call known Kling credit APIs directly using session cookies ──────
    console.log('Calling credit APIs...');
    const creditEndpoints = [
      '/api/user/credit/balance',
      '/api/user/credits',
      '/api/member/credit',
      '/api/member/info',
      '/api/membership/credit',
      '/api/user/quota',
      '/api/user/profile',
      '/api/user/info',
    ];

    for (const endpoint of creditEndpoints) {
      const result = await page.evaluate(async (ep) => {
        try {
          const r = await fetch(ep, { credentials: 'include' });
          if (!r.ok) return null;
          const j = await r.json();
          return { url: ep, body: JSON.stringify(j).slice(0, 500) };
        } catch { return null; }
      }, endpoint);

      if (result) {
        console.log('API ' + result.url + ' → ' + result.body);
        try {
          const parsed = JSON.parse(result.body.length < 500
            ? result.body
            : await page.evaluate(async (ep) => {
                const r = await fetch(ep, { credentials: 'include' });
                return JSON.stringify(await r.json());
              }, endpoint));
          const found = findCreditsInObject(parsed);
          if (found !== null) {
            console.log('Credits from ' + endpoint + ': ' + found);
            creditsFromApi = found;
            break;
          }
        } catch { /* parse error, continue */ }
      }
    }

    // ── 5. Navigate to membership to trigger more API calls ────────────────
    if (creditsFromApi === null) {
      console.log('Direct API calls found nothing. Navigating to /membership...');
      await page.goto('https://kling.ai/app/membership', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      await page.screenshot({ path: 'ss5-membership.png' });
      console.log('APIs seen on membership page: ' + [...new Set(seenApis)].join(', '));
    }

    await page.screenshot({ path: 'ss6-credits-tab.png' });

    if (creditsFromApi !== null) {
      console.log('Final credits from API: ' + creditsFromApi);
      await browser.close();
      return creditsFromApi;
    }

    // ── 6. Last resort: scrape visible page text ───────────────────────────
    console.log('API approach failed — falling back to page scrape...');
    const credits = await scrapeCredits(page);
    console.log('Credits from scrape: ' + credits);
    await browser.close();
    return credits;

  } catch (err) {
    await page.screenshot({ path: 'ss-error.png' }).catch(() => {});
    await browser.close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Recursively search a JSON object for a credit balance value.
// Looks for keys named "credit", "balance", "remaining", "quota" etc.
// that have numeric values in a plausible range (100–10,000,000).
// ---------------------------------------------------------------------------
function findCreditsInObject(obj, depth = 0) {
  if (depth > 8 || obj === null || typeof obj !== 'object') return null;

  const creditKeys = ['credit', 'credits', 'balance', 'remaining', 'quota',
                      'amount', 'total', 'available', 'coin', 'point'];

  for (const key of Object.keys(obj)) {
    const keyLower = key.toLowerCase();
    const val = obj[key];

    if (creditKeys.some(k => keyLower.includes(k))) {
      if (typeof val === 'number' && val >= 100 && val <= 10000000) {
        console.log('Credit key match: ' + key + ' = ' + val);
        return Math.round(val);
      }
      if (typeof val === 'string' && /^\d+$/.test(val)) {
        const n = parseInt(val);
        if (n >= 100 && n <= 10000000) {
          console.log('Credit key match (string): ' + key + ' = ' + n);
          return n;
        }
      }
    }

    // Recurse into nested objects and arrays
    if (typeof val === 'object' && val !== null) {
      const found = findCreditsInObject(val, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credit scraping — multiple fallback strategies.
// Known noise to ignore: countdown timer digits (06, 27, 35), plan tier sizes
// (660, 3000, 8000, 26000, 30000), pricing ($72, $269), seat counts (3).
// The real balance is a standalone number like 16000, 9500, etc.
// ---------------------------------------------------------------------------
async function scrapeCredits(page) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l);

  console.log('--- Page text (all non-empty lines) ---');
  lines.forEach((l, i) => console.log(i + ': ' + l));
  console.log('--- End ---');

  // Strategy 0a: "16k" / "16K" abbreviated format (sidebar display)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+(?:\.\d+)?)[kK]$/);
    if (m) {
      const val = Math.round(parseFloat(m[1]) * 1000);
      if (val >= 1000 && val <= 10000000) {
        console.log('Strategy 0a — k-abbreviated: ' + val);
        return val;
      }
    }
  }

  // Strategy 0b: inline pattern "16,000 Credits" or "16000 Credits" on one line
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\d,]+)\s+credits?$/i);
    if (m) {
      const val = parseInt(m[1].replace(/,/g, ''));
      // Exclude known plan tier sizes
      if (![660, 3000, 8000, 10000, 26000, 30000].includes(val)) {
        console.log('Strategy 0 — inline "N Credits" pattern: ' + val);
        return val;
      }
    }
  }

  // Strategy 1: "Remaining Credits" label — the most explicit signal
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes('remaining credits')) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^\d[\d,]*$/.test(lines[j])) {
          const val = parseInt(lines[j].replace(/,/g, ''));
          console.log('Strategy 1 — remaining credits: ' + val);
          return val;
        }
      }
    }
  }

  // Strategy 2: "Total Credits" or "Available Credits" label
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if ((l.includes('total credits') || l.includes('available credits') || l.includes('credits available')) && !l.includes('per month')) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^\d[\d,]*$/.test(lines[j])) {
          const val = parseInt(lines[j].replace(/,/g, ''));
          console.log('Strategy 2 — total/available credits label: ' + val);
          return val;
        }
      }
    }
  }

  // Strategy 3: standalone number filtered to exclude all known noise.
  // Countdown timers are always ≤ 59. Plan tier sizes are a known set.
  // Pricing lines have $ in adjacent lines. We want numbers ≥ 100 that
  // don't match any noise pattern.
  const knownPlanTiers = new Set([660, 3000, 8000, 10000, 26000, 30000]);
  for (let i = 0; i < lines.length; i++) {
    if (/^\d[\d,]+$/.test(lines[i])) {
      const val = parseInt(lines[i].replace(/,/g, ''));
      if (val < 100) continue;                          // timers and tiny counts
      if (knownPlanTiers.has(val)) continue;            // plan tier sizes
      const nextLine = (lines[i + 1] || '').toLowerCase();
      const prevLine = (lines[i - 1] || '').toLowerCase();
      if (nextLine.includes('per month') || nextLine.includes('per year') ||
          nextLine.includes('/ year') || nextLine.includes('team credits')) continue;
      if (prevLine.includes('$') || prevLine.includes('renewal') ||
          prevLine.includes('seat') || prevLine.includes('year')) continue;
      console.log('Strategy 3 — standalone number (filtered): ' + val);
      return val;
    }
  }

  // Strategy 4: DOM — target leaf elements with credit-related classes,
  // then fall back to any leaf number ≥ 100 not matching a plan tier size.
  const domCredit = await page.evaluate((knownTiers) => {
    const creditEls = [...document.querySelectorAll('[class*="credit" i], [class*="balance" i], [class*="remain" i]')];
    for (const el of creditEls) {
      const text = (el.innerText || '').trim();
      if (/^\d[\d,]+$/.test(text)) {
        const val = parseInt(text.replace(/,/g, ''));
        if (val >= 100 && !knownTiers.includes(val)) return val;
      }
    }
    const all = [...document.querySelectorAll('span, p, div, h1, h2, h3')];
    for (const el of all) {
      if (el.children.length > 0) continue;
      const text = (el.innerText || '').trim();
      if (/^\d[\d,]+$/.test(text)) {
        const val = parseInt(text.replace(/,/g, ''));
        if (val >= 100 && val < 1000000 && !knownTiers.includes(val)) return val;
      }
    }
    return null;
  }, [660, 3000, 8000, 10000, 26000, 30000]);

  if (domCredit !== null) {
    console.log('Strategy 4 — DOM scan: ' + domCredit);
    return domCredit;
  }

  throw new Error('Could not find credit balance. Check ss5-membership.png / ss6-credits-tab.png for the current page layout.');
}

// ---------------------------------------------------------------------------
// Slack notification
// ---------------------------------------------------------------------------
async function sendSlackUpdate(credits) {
  if (!CONFIG.slackWebhookUrl) {
    console.warn('No SLACK_WEBHOOK_URL set — skipping Slack notification');
    return;
  }

  const isUrgent  = credits < 2000;
  const isWarning = credits >= 2000 && credits < 4000;
  const isLow     = credits <= CONFIG.threshold;
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const icon       = isUrgent ? ':rotating_light:' : isWarning ? ':warning:' : ':white_check_mark:';
  // In debug mode: suppress @channel/@here mentions and add a debug label
  const debugMode  = !!CONFIG.debugSlackUser;
  const mention    = debugMode ? '' : (isUrgent ? '<!channel> ' : isWarning ? '<!here> ' : '');
  const debugTag   = debugMode ? ' _(debug — channel suppressed)_' : '';
  const statusText = isUrgent
    ? credits.toLocaleString() + ' credits remaining - action needed!'
    : isWarning
    ? credits.toLocaleString() + ' credits remaining - running low'
    : 'OK';

  const blocks = [
    ...(debugMode ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: ':construction: *Debug mode* — alerts are DM-only until scraper is verified.' + debugTag },
    }] : []),
    ...(isUrgent || isWarning ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: mention + '*Kling.ai credits: ' + statusText + '*' },
    }] : []),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Kling.ai credits*\n' + icon + ' *' + credits.toLocaleString() + '* - ' + statusText },
        { type: 'mrkdwn', text: '*Checked at*\n' + now },
      ],
    },
    ...(isUrgent || isWarning || isLow ? [{
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Top up credits' },
        url: 'https://kling.ai/app/membership/membership-plan',
        style: 'danger',
      }],
    }] : []),
  ];

  // If DEBUG_SLACK_USER is set, send as a DM to that user only.
  // The webhook payload uses "channel" to override the webhook's default destination.
  const payload = {
    text: mention + (isUrgent ? 'URGENT' : isWarning ? 'WARNING' : 'OK') + ' Kling.ai credits: ' + credits.toLocaleString() + debugTag,
    blocks,
    ...(debugMode ? { channel: CONFIG.debugSlackUser } : {}),
  };

  const response = await fetch(CONFIG.slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error('Slack webhook failed: ' + response.status + ' ' + response.statusText);
  }

  console.log('Slack update sent!' + (debugMode ? ' (DM to ' + CONFIG.debugSlackUser + ')' : ''));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  try {
    const credits = await checkKlingCredits();

    if (CONFIG.hourlyMode && credits >= CONFIG.hourlyThreshold) {
      console.log('Hourly mode: credits healthy (' + credits + '), skipping Slack.');
      return;
    }

    await sendSlackUpdate(credits);

  } catch (err) {
    console.error('Error: ' + err.message);
    if (CONFIG.slackWebhookUrl) {
      await fetch(CONFIG.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ':x: Kling.ai credit monitor failed: ' + err.message }),
      }).catch(() => {});
    }
    process.exit(1);
  }
})();
