// Kling.ai Credit Monitor
// Checks credits every 2 hours and posts balance to Slack.
// Adds a warning flag if credits drop at or below CREDIT_THRESHOLD.
//
// SETUP:
//   1. npm init -y && npm install playwright dotenv
//   2. npx playwright install chromium
//   3. Fill in your .env file
//   4. Test: HEADLESS=false node kling-credit-monitor.js
//   5. Cron (every 2 hours): 0 */2 * * * cd ~/Desktop/kling-monitor && node kling-credit-monitor.js >> kling-monitor.log 2>&1

import { chromium } from 'playwright';
import * as dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  threshold: parseInt(process.env.CREDIT_THRESHOLD || '100'),
  slackChannel: process.env.SLACK_CHANNEL || '#production-credits-monitor',
  teamName: process.env.TEAM_NAME || 'the team',
  klingEmail: process.env.KLING_EMAIL,
  klingPassword: process.env.KLING_PASSWORD,
  headless: process.env.HEADLESS !== 'false',
};

async function checkKlingCredits() {
  console.log('Checking Kling.ai credits...');

  if (!CONFIG.klingEmail || !CONFIG.klingPassword) {
    throw new Error('Missing KLING_EMAIL or KLING_PASSWORD in .env file');
  }

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://kling.ai/app', { waitUntil: 'networkidle' });

    const isLoggedIn = await page.$('[data-testid="user-avatar"], .user-avatar, .account-menu')
      .then(el => !!el).catch(() => false);

    if (!isLoggedIn) {
      console.log('Logging in...');
      await login(page, CONFIG.klingEmail, CONFIG.klingPassword);
    }

    // Go directly to the membership page
    await page.goto('https://kling.ai/app/membership/membership-plan', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Dismiss any popup (translation prompt, banners, etc.) that may appear
    const popupSelectors = [
      'button:has-text("English")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      'button:has-text("Close")',
      'button:has-text("Confirm")',
      '[class*="close"]',
      '[aria-label="close"]',
      '[aria-label="Close"]',
    ];
    for (const sel of popupSelectors) {
      try {
        await page.click(sel, { timeout: 2000 });
        await page.waitForTimeout(500);
      } catch {
        // no popup with this selector, continue
      }
    }

    // Also try pressing Escape to close any overlay
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const credits = await scrapeCredits(page);
    console.log('Credits found: ' + credits);
    // Navigate to the membership page to read credits
    // Click the bottom-left green coin / subscription indicator in the sidebar
    try {
      await page.click('[class*="member-center"], [href*="member"], [href*="membership"]', { timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch {
      // may already be navigated there, or scrapeCredits will handle it
    }

    await browser.close();
    return credits;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function login(page, email, password) {
  // Close any pop-up overlays first
  try {
    await page.click('[class*="close"], [aria-label="close"], button:has-text("×")', { timeout: 3000 });
    await page.waitForTimeout(500);
  } catch {
    // no overlay, continue
  }

  // Click the "Sign In" link in the left sidebar
  await page.click('text="Sign In"', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Click "Sign in with email" to reveal the email/password form
  await page.click('text="Sign in with email"', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Fill in credentials
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.waitForTimeout(500);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.waitForTimeout(500);
  await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Login"), button:has-text("Continue")');

  // Wait for the app to load rather than a specific navigation event
  await page.waitForTimeout(4000);
  await page.waitForLoadState('domcontentloaded');
}

async function scrapeCredits(page) {
  // Navigate to the membership/credits page by clicking the account area in the sidebar
  try {
    await page.click('[class*="member"], [class*="subscription"], [href*="member"], [href*="subscription"]', { timeout: 5000 });
  } catch {
    // Try clicking the bottom-left user/credit indicator (shows green coin + number)
    try {
      await page.click('[class*="user"], [class*="account"], [class*="credit-icon"]', { timeout: 5000 });
    } catch {
      // Already on the right page, or will find credits in body text
    }
  }
  await page.waitForTimeout(2000);

  // Page now shows "Credits 🟢 18135" at the top — grab the number after "Credits"
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n');

  for (const line of lines) {
    // Match lines like "Credits  18135" or "Credits 🟢 18135"
    if (/^credits/i.test(line.trim()) && /\d{3,}/.test(line)) {
      const numbers = line.match(/[\d,]+/g);
      if (numbers) {
        // Take the largest number on the line (the total balance, not the expiring subset)
        const vals = numbers.map(n => parseInt(n.replace(/,/g, '')));
        return Math.max(...vals);
      }
    }
  }

  // Fallback: any line with "credit" and a 4+ digit number
  for (const line of lines) {
    if (line.toLowerCase().includes('credit') && /\d{4,}/.test(line)) {
      const match = line.match(/[\d,]+/);
      if (match) return parseInt(match[0].replace(/,/g, ''));
    }
  }

  throw new Error('Could not find credit balance. Try running with HEADLESS=false to inspect the page.');
}

async function sendSlackUpdate(credits) {
  if (!CONFIG.slackWebhookUrl) {
    console.warn('No SLACK_WEBHOOK_URL set — skipping Slack notification');
    return;
  }

  const isLow = credits <= CONFIG.threshold;
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const statusIcon = isLow ? 'WARNING' : 'OK';
  const statusText = isLow
    ? 'Low — at or below threshold of ' + CONFIG.threshold.toLocaleString()
    : 'OK';

  const payload = {
    text: statusIcon + ' Kling.ai credits: ' + credits.toLocaleString(),
    blocks: [
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Kling.ai credits*\n' + (isLow ? ':warning:' : ':white_check_mark:') + ' *' + credits.toLocaleString() + '* — ' + statusText },
          { type: 'mrkdwn', text: '*Checked at*\n' + now },
        ],
      },
      ...(isLow ? [{
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Top up credits' },
          url: 'https://kling.ai/app',
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

  console.log('Slack update sent successfully!');
}

(async () => {
  try {
    const credits = await checkKlingCredits();

    if (credits <= CONFIG.threshold) {
      console.log('Credits low: ' + credits + ' (threshold: ' + CONFIG.threshold + ')');
    } else {
      console.log('Credits OK: ' + credits + ' (threshold: ' + CONFIG.threshold + ')');
    }

    await sendSlackUpdate(credits);

  } catch (err) {
    console.error('Error: ' + err.message);

    if (CONFIG.slackWebhookUrl) {
      await fetch(CONFIG.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Kling.ai credit monitor failed to run: ' + err.message,
        }),
      }).catch(() => {});
    }

    process.exit(1);
  }
})();