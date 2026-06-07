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
};

// ---------------------------------------------------------------------------
// Modal dismissal — robust against whatever promo Kling throws up.
// Keeps trying until no more dismissible buttons are found OR until the
// overlay is gone from the DOM. Does NOT break early on first click.
// ---------------------------------------------------------------------------
async function dismissAllModals(page) {
  console.log('Dismissing modals...');

  // 1. Escape key
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  // 2. Targeted close-button selectors (Kling anniversary modal uses a plain
  //    circular button with an × icon — no special class, just small & visible)
  const closeSelectors = [
    '[aria-label="close" i]',
    '[aria-label="dismiss" i]',
    '[class*="close" i]',
    '[class*="dismiss" i]',
    '[class*="modal"] button',
    '[class*="popup"] button',
    '[class*="overlay"] button',
  ];
  for (const sel of closeSelectors) {
    try {
      await page.click(sel, { timeout: 1000 });
      console.log('Dismissed via selector: ' + sel);
      await page.waitForTimeout(800);
    } catch { /* not present, move on */ }
  }

  // 3. JS scan — find any small button (< 60px) in the upper half of the
  //    viewport that is still visible. Run up to 6 times so stacked modals
  //    each get dismissed in turn. Wait 800ms between clicks for animations.
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"]')];
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (
          rect.width > 0 && rect.height > 0 &&
          rect.width < 60 && rect.height < 60 &&
          rect.top > 0 && rect.top < 520 &&
          rect.left > 0
        ) {
          btn.click();
          return `Clicked small button at (${Math.round(rect.left)}, ${Math.round(rect.top)}) size ${Math.round(rect.width)}x${Math.round(rect.height)}`;
        }
      }
      return null;
    });

    if (result) {
      console.log('Modal JS dismiss attempt ' + (attempt + 1) + ': ' + result);
      await page.waitForTimeout(800); // wait for CSS animation to finish
    } else {
      console.log('No more dismissible buttons found after ' + attempt + ' attempt(s)');
      break;
    }
  }

  // 4. Final fallback — click the top-left corner (outside any modal content)
  await page.mouse.click(20, 20).catch(() => {});
  await page.waitForTimeout(600);

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
// Main entry point
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

  try {
    // ── 1. Land on the app ──────────────────────────────────────────────────
    await page.goto('https://kling.ai/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'ss1-initial.png' });
    console.log('Page title: ' + await page.title());

    // ── 2. Dismiss any promotional / cookie modals ──────────────────────────
    await dismissAllModals(page);
    await page.screenshot({ path: 'ss2-after-dismiss.png' });

    // ── 3. Decide: already logged in, or need to log in? ───────────────────
    // IMPORTANT: isAlreadyLoggedIn() must run AFTER dismissAllModals() —
    // modal overlays intercept DOM queries and cause false negatives.
    const loggedIn = await isAlreadyLoggedIn(page);
    console.log('Already logged in: ' + loggedIn);

    if (!loggedIn) {
      await performLogin(page);
    } else {
      console.log('Session active — skipping login flow.');
    }

    // ── 4. Go directly to the membership/credits page ──────────────────────
    console.log('Navigating to credits page...');
    await page.goto('https://kling.ai/app/membership', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'ss5-membership.png' });

    // Dismiss any modal that appeared on the membership page too
    await dismissAllModals(page);

    // ── 5. Click the "Credits" tab if present ──────────────────────────────
    try {
      await page.click('text="Credits"', { timeout: 5000 });
      console.log('Clicked Credits tab');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'ss6-credits-tab.png' });
    } catch {
      console.log('No Credits tab found — reading from current page...');
    }

    const credits = await scrapeCredits(page);
    console.log('Credits found: ' + credits);
    await browser.close();
    return credits;

  } catch (err) {
    await page.screenshot({ path: 'ss-error.png' }).catch(() => {});
    await browser.close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Credit scraping — multiple fallback strategies
// ---------------------------------------------------------------------------
async function scrapeCredits(page) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n');

  console.log('--- Page text sample (first 50 non-empty lines) ---');
  lines
    .slice(0, 80)
    .forEach((l, i) => { if (l.trim()) console.log(i + ': ' + l.trim()); });
  console.log('--- End sample ---');

  // Strategy 1: "Remaining Credits" label
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase().includes('remaining credits')) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (/^\d[\d,]*$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          console.log('Strategy 1 — remaining credits: ' + val);
          return val;
        }
      }
    }
  }

  // Strategy 2: "Total Credits" / "Available" / "Balance" label
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    if (line.includes('total') || line.includes('available') || line.includes('balance')) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (/^\d[\d,]*$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          if (val > 0) {
            console.log('Strategy 2 — total/available/balance: ' + val);
            return val;
          }
        }
      }
    }
  }

  // Strategy 3: standalone "Credits" label followed immediately by a number
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === 'credits') {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const next = lines[j].trim();
        if (/^\d[\d,]*$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          console.log('Strategy 3 — credits label: ' + val);
          return val;
        }
        if (next.length > 0 && !/^\d/.test(next)) break;
      }
    }
  }

  // Strategy 4: DOM query — look for elements that visually display the
  // credit number (large standalone numbers adjacent to credit-related text)
  const domCredit = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('*')];
    for (const el of candidates) {
      const text = (el.innerText || '').trim();
      if (/^\d[\d,]{2,}$/.test(text)) { // 3+ digit number
        // Check if a nearby ancestor/sibling mentions "credit"
        const parent = el.closest('[class*="credit"], [class*="Credit"], [class*="balance"], [class*="Balance"]');
        if (parent) return parseInt(text.replace(/,/g, ''));
      }
    }
    return null;
  });
  if (domCredit !== null) {
    console.log('Strategy 4 — DOM class heuristic: ' + domCredit);
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
  const mention    = isUrgent ? '<!channel> '       : isWarning ? '<!here> '  : '';
  const statusText = isUrgent
    ? credits.toLocaleString() + ' credits remaining - action needed!'
    : isWarning
    ? credits.toLocaleString() + ' credits remaining - running low'
    : 'OK';

  const payload = {
    text: mention + (isUrgent ? 'URGENT' : isWarning ? 'WARNING' : 'OK') + ' Kling.ai credits: ' + credits.toLocaleString(),
    blocks: [
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
    ],
  };

  const response = await fetch(CONFIG.slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error('Slack webhook failed: ' + response.status + ' ' + response.statusText);
  }

  console.log('Slack update sent!');
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
