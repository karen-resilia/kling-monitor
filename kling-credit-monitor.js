// Kling.ai Credit Monitor
// Posts credit balance to Slack every 2 hours.
// Adds escalating alerts based on credit thresholds.

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

async function checkKlingCredits() {
  console.log('Checking Kling.ai credits...');

  if (!CONFIG.klingEmail || !CONFIG.klingPassword) {
    throw new Error('Missing KLING_EMAIL or KLING_PASSWORD in .env file');
  }

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://kling.ai/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'ss1-initial.png' });
    console.log('Page title: ' + await page.title());

    // Try every possible login entry point in order of likelihood
    // Each attempt is independent — if one works we move on
    const loginEntryPoints = [
      'button:has-text("Sign In to Claim Gift")',
      'a:has-text("Sign In to Claim Gift")',
      'button:has-text("Join Now!")',
      'a:has-text("Join Now!")',
      'text="Sign In"',
      'text="Sign in"',
      'button:has-text("Sign In")',
      'a[href*="login"]',
    ];

    let entryFound = false;
    for (const sel of loginEntryPoints) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log('Clicked login entry: ' + sel);
        entryFound = true;
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'ss2-after-entry.png' });
        break;
      } catch { continue; }
    }

    if (!entryFound) {
      await page.screenshot({ path: 'ss2-no-entry-found.png' });
      const els = await page.evaluate(() =>
        [...document.querySelectorAll('a, button')].map(e => e.innerText.trim()).filter(t => t).slice(0, 30).join(' | ')
      );
      console.log('No login entry found. Clickable elements: ' + els);
      throw new Error('Could not find any login entry point on the page');
    }

    // Now we should be on the login modal — click "Sign in with email"
    await page.screenshot({ path: 'ss3-before-email-click.png' });
    await page.click('text="Sign in with email"', { timeout: 10000 });
    console.log('Clicked Sign in with email');
    // Wait for the email input to actually appear
    await page.waitForSelector('input[placeholder="Enter Email Address"], input[type="email"]', { timeout: 10000 });
    console.log('Email input appeared');

    // Step 6: Fill credentials
    await page.fill('input[placeholder="Enter Email Address"], input[type="email"]', CONFIG.klingEmail);
    console.log('Filled email');
    await page.waitForTimeout(500);
    await page.fill('input[placeholder="Password"], input[type="password"]', CONFIG.klingPassword);
    console.log('Filled password');
    await page.waitForTimeout(500);
    await page.click('button:has-text("Sign In"):not(:has-text("with")):not(:has-text("Google")):not(:has-text("Apple")), button[type="submit"]');
    console.log('Clicked Sign In button');
    await page.waitForTimeout(5000);

    // Step 7: Navigate directly to the Credits tab on the membership page
    console.log('Navigating to credits page...');
    await page.goto('https://kling.ai/app/membership', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Click the "Credits" tab to see the credit balance
    try {
      await page.click('text="Credits"', { timeout: 5000 });
      console.log('Clicked Credits tab');
      await page.waitForTimeout(2000);
    } catch {
      console.log('No Credits tab found, reading from current page...');
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

async function scrapeCredits(page) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n');

  console.log('--- Page text sample ---');
  lines.slice(0, 40).forEach((l, i) => { if (l.trim()) console.log(i + ': ' + l.trim()); });
  console.log('--- End sample ---');

  // Strategy 1: "Remaining Credits" label (from credit details modal)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase().includes('remaining credits')) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (/^\d[\d,]*$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          console.log('Found remaining credits: ' + val);
          return val;
        }
      }
    }
  }

  // Strategy 2: Credits tab page — shows "Total Credits" or "Available" near the top
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    if (line.includes('total') || line.includes('available') || line.includes('balance')) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (/^\d[\d,]*$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          if (val > 0) {
            console.log('Found credits via total/available: ' + val);
            return val;
          }
        }
      }
    }
  }

  // Strategy 3: "Credits" label then number on VERY NEXT non-empty line
  // Page structure: line N = "Credits", line N+1 = "3" (the balance)
  // We want the FIRST "Credits" occurrence that is followed immediately by a standalone number
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === 'credits') {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const next = lines[j].trim();
        // Must be a standalone number (no other text), any size
        if (/^\d[\d,]*$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          console.log('Found credits after Credits label: ' + val);
          return val;
        }
        // Stop looking if we hit non-numeric content
        if (next.length > 0 && !/^\d/.test(next)) break;
      }
    }
  }

  throw new Error('Could not find credit balance.');
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

  const icon = isUrgent ? ':rotating_light:' : isWarning ? ':warning:' : ':white_check_mark:';
  const mention = isUrgent ? '<!channel> ' : isWarning ? '<!here> ' : '';
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
        body: JSON.stringify({ text: 'Kling.ai credit monitor failed: ' + err.message }),
      }).catch(() => {});
    }
    process.exit(1);
  }
})();
