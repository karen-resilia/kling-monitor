// Kling.ai Credit Monitor
// Posts credit balance to Slack every 2 hours.
// Adds a warning flag if credits drop at or below CREDIT_THRESHOLD.

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

  // Try multiple selectors for the Sign In button
  const signInSelectors = [
    'text="Sign In"',
    'text="Sign in"',
    'text="Login"',
    'a:has-text("Sign In")',
    'button:has-text("Sign In")',
    '[class*="sign-in"]',
    '[class*="login"]',
    '[href*="login"]',
    '[href*="sign-in"]',
  ];

  let clicked = false;
  for (const sel of signInSelectors) {
    try {
      await page.click(sel, { timeout: 5000 });
      clicked = true;
      console.log('Clicked sign in with selector: ' + sel);
      break;
    } catch {
      continue;
    }
  }

  if (!clicked) {
    throw new Error('Could not find Sign In button. Page title: ' + await page.title());
  }

  await page.waitForTimeout(2000);

  // Click "Sign in with email"
  try {
    await page.click('text="Sign in with email"', { timeout: 8000 });
    await page.waitForTimeout(1500);
  } catch {
    // may already be on email form
  }

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

  for (const line of lines) {
    if (/^credits/i.test(line.trim()) && /\d{3,}/.test(line)) {
      const numbers = line.match(/[\d,]+/g);
      if (numbers) {
        const vals = numbers.map(n => parseInt(n.replace(/,/g, '')));
        return Math.max(...vals);
      }
    }
  }

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
    console.warn('No SLACK_WEBHOOK_URL set - skipping Slack notification');
    return;
  }

  const isLow = credits <= CONFIG.threshold;
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const statusText = isLow
    ? 'Low - at or below threshold of ' + CONFIG.threshold.toLocaleString()
    : 'OK';

  const payload = {
    text: (isLow ? 'WARNING' : 'OK') + ' Kling.ai credits: ' + credits.toLocaleString(),
    blocks: [
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Kling.ai credits*\n' + (isLow ? ':warning:' : ':white_check_mark:') + ' *' + credits.toLocaleString() + '* - ' + statusText },
          { type: 'mrkdwn', text: '*Checked at*\n' + now },
        ],
      },
      ...(isLow ? [{
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
