// Kling.ai Credit Monitor
// Posts credit balance to Slack every 2 hours.
// Adds a warning flag if credits drop at or below CREDIT_THRESHOLD.

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
  // When true: only post if credits are below hourlyThreshold (used by the hourly job)
  hourlyMode: process.env.HOURLY_MODE === 'true',
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
    // Try going directly to the login page
    await page.goto('https://kling.ai/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log('Page title: ' + await page.title());
    console.log('Page URL: ' + page.url());

    const isLoggedIn = await page.$('[class*="user-avatar"], [class*="account-menu"], [class*="member"]')
      .then(el => !!el).catch(() => false);

    if (!isLoggedIn) {
      console.log('Logging in...');
      await login(page, CONFIG.klingEmail, CONFIG.klingPassword);
    }

    await page.goto('https://kling.ai/app/membership/membership-plan', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

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
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const credits = await scrapeCredits(page);
    console.log('Credits found: ' + credits);
    await browser.close();
    return credits;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function login(page, email, password) {
  // Dismiss any overlay
  try {
    await page.click('[class*="close"], [aria-label="close"], button:has-text("x")', { timeout: 3000 });
    await page.waitForTimeout(500);
  } catch {
    // no overlay
  }

  // Wait for page to fully settle then find Sign In button
  await page.waitForTimeout(3000);
  console.log('Login page title: ' + await page.title());
  console.log('Login page URL: ' + page.url());

  // Dump all button/link text to help debug
  const allText = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a, button')];
    return els.map(e => e.innerText.trim()).filter(t => t.length > 0).slice(0, 30).join(' | ');
  });
  console.log('Clickable elements: ' + allText);

  // Step 1: Dismiss any promotional popups (anniversary, claim gift, etc.)
  const popupDismissSelectors = [
    'button[class*="close"]',
    '[aria-label="Close"]',
    '[aria-label="close"]',
    'button:has-text("×")',
    'button:has-text("x")',
  ];
  for (const sel of popupDismissSelectors) {
    try {
      await page.click(sel, { timeout: 2000 });
      console.log('Dismissed popup with: ' + sel);
      await page.waitForTimeout(1000);
      break;
    } catch { continue; }
  }
  // Also try Escape key to close any overlay
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  // Step 2: Find and click the Sign In button in the sidebar
  const signInSelectors = [
    'text="Sign In"',
    'text="Sign in"',
    'a:has-text("Sign In")',
    'button:has-text("Sign In")',
    'text="Login"',
    '[class*="sign-in"]',
    '[class*="login"]',
  ];
  let clicked = false;
  for (const sel of signInSelectors) {
    try {
      await page.click(sel, { timeout: 5000 });
      clicked = true;
      console.log('Clicked sign in with: ' + sel);
      break;
    } catch { continue; }
  }
  if (!clicked) {
    // Last resort: log all clickable text to help debug
    const allText = await page.evaluate(() => {
      const els = [...document.querySelectorAll('a, button')];
      return els.map(e => e.innerText.trim()).filter(t => t.length > 0).slice(0, 40).join(' | ');
    });
    console.log('Clickable elements: ' + allText);
    throw new Error('Could not find Sign In button. Page title: ' + await page.title());
  }
  await page.waitForTimeout(2000);

  // Step 3: Click "Sign in with email" if shown
  try {
    await page.click('text="Sign in with email"', { timeout: 8000 });
    await page.waitForTimeout(1500);
  } catch { /* may already be on email/password form */ }

  await page.fill('input[type="email"], input[name="email"]', email);
  await page.waitForTimeout(500);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.waitForTimeout(500);
  await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Login"), button:has-text("Continue")');

  await page.waitForTimeout(5000);
  await page.waitForLoadState('domcontentloaded');
}

async function scrapeCredits(page) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n');

  console.log('--- Page text sample ---');
  lines.slice(0, 40).forEach((l, i) => { if (l.trim()) console.log(i + ': ' + l.trim()); });
  console.log('--- End sample ---');

  // The page structure is:
  // line N:   "Credits"
  // line N+1: "18135"   <-- this is the total balance we want
  // line N+2: "2135Credits will expire..." <-- this is NOT what we want
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === 'credits') {
      // Next non-empty line should be the total balance
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (/^[\d,]+$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          console.log('Found credits on line ' + j + ': ' + val);
          return val;
        }
      }
    }
  }

  // Fallback: find largest standalone number near "Credits"
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === 'credits') {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const match = lines[j].trim().match(/^[\d,]+/);
        if (match) {
          const val = parseInt(match[0].replace(/,/g, ''));
          console.log('Fallback credits on line ' + j + ': ' + val);
          return val;
        }
      }
    }
  }

  throw new Error('Could not find credit balance. Try running with HEADLESS=false to inspect the page.');
}

async function sendSlackUpdate(credits) {
  if (!CONFIG.slackWebhookUrl) {
    console.warn('No SLACK_WEBHOOK_URL set - skipping Slack notification');
    return;
  }

  const isUrgent = credits < 2000;
  const isWarning = credits >= 2000 && credits < 4000;
  const isLow = credits <= CONFIG.threshold;
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  // Icons and mentions per tier
  // Under 2,000  → 🚨 @channel  "X credits remaining — action needed!"
  // Under 5,000  → ⚠️ @here     "X credits remaining — running low"
  // OK           → ✅ no ping   "OK"
  const icon = isUrgent ? ':rotating_light:' : isWarning ? ':warning:' : ':white_check_mark:';
  const mention = isUrgent ? '<!channel> ' : isWarning ? '<!here> ' : '';

  const statusText = isUrgent
    ? credits.toLocaleString() + ' credits remaining — action needed!'
    : isWarning
    ? credits.toLocaleString() + ' credits remaining — running low'
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

    // In hourly mode, only post to Slack if credits are below the hourly threshold
    if (CONFIG.hourlyMode && credits >= CONFIG.hourlyThreshold) {
      console.log('Hourly mode: credits are healthy (' + credits + ' >= ' + CONFIG.hourlyThreshold + '), skipping Slack update.');
      return;
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
