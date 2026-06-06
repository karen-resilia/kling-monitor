// Kling.ai Credit Monitor
// Posts credit balance to Slack every 2 hours.
// Adds escalating alerts based on credit thresholds.
//
// FIX (2026-06-06): The script previously assumed the page would always show
// a login form. Kling now loads the authenticated dashboard directly when a
// valid session exists (GitHub Actions runners don't persist cookies, so the
// flow is: unauthenticated → promo modal → dashboard WITH no login buttons).
// The fix: after dismissing any modal, check whether we're already on the
// dashboard. If yes, skip the entire login flow and go straight to credits.

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
// Modal dismissal — robust against whatever promo Kling throws up
// ---------------------------------------------------------------------------
async function dismissAllModals(page) {
  // 1. Escape key (handles some modals instantly)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  // 2. JS scan: click every small button near the top of the viewport
  //    (anniversary banners, promo popups, cookie notices, etc.)
  let attempts = 0;
  while (attempts < 5) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"], [class*="close"], [class*="dismiss"], [aria-label*="close" i], [aria-label*="dismiss" i]')];
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.width < 60 && rect.height < 60 && rect.top < 500) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (!clicked) break;
    await page.waitForTimeout(600);
    attempts++;
  }

  // 3. Click outside any remaining overlay
  await page.mouse.click(50, 50).catch(() => {});
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// Detect whether the app dashboard is showing (i.e. we're already logged in)
// ---------------------------------------------------------------------------
async function isAlreadyLoggedIn(page) {
  // The authenticated dashboard always has these nav items in the sidebar
  const dashboardSignals = [
    '[class*="sidebar"]',
    '[class*="nav-item"]',
    'text="Image Generation"',
    'text="Video Generation"',
    'text="Explore"',
  ];
  for (const sel of dashboardSignals) {
    try {
      await page.waitForSelector(sel, { timeout: 2000 });
      return true;
    } catch { continue; }
  }
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
