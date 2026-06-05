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

    // Step 1: Close the anniversary popup by clicking its X button
    try {
      // The X button is inside the anniversary popup modal
      await page.click('.modal-close, [class*="modal"] button[class*="close"], button[class*="close"]:visible', { timeout: 3000 });
      console.log('Closed popup via selector');
    } catch {
      console.log('No close selector found, trying Join Now...');
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'ss2-after-close.png' });

    // Step 2: If Join Now is visible, click it to open the login modal
    try {
      await page.click('button:has-text("Join Now!"), a:has-text("Join Now!")', { timeout: 3000 });
      console.log('Clicked Join Now');
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'ss3-after-joinnow.png' });
    } catch {
      console.log('No Join Now button');
    }

    // Step 3: If "Sign In to Claim Gift" is visible, click it
    try {
      await page.click('button:has-text("Sign In to Claim Gift"), a:has-text("Sign In to Claim Gift")', { timeout: 3000 });
      console.log('Clicked Sign In to Claim Gift');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'ss4-after-claimgift.png' });
    } catch {
      console.log('No Sign In to Claim Gift');
    }

    // Step 4: If Sign In sidebar link is visible, click it
    try {
      await page.click('text="Sign In"', { timeout: 3000 });
      console.log('Clicked Sign In sidebar');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'ss5-after-signin.png' });
    } catch {
      console.log('No Sign In sidebar link');
    }

    // Step 5: Click "Sign in with email"
    try {
      await page.click('text="Sign in with email"', { timeout: 3000 });
      console.log('Clicked Sign in with email');
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'ss6-after-emailoption.png' });
    } catch {
      console.log('No Sign in with email option');
    }

    // Step 6: Fill credentials
    await page.screenshot({ path: 'ss7-before-fill.png' });
    await page.fill('input[placeholder="Enter Email Address"], input[type="email"], input[name="email"]', CONFIG.klingEmail);
    console.log('Filled email');
    await page.waitForTimeout(500);
    await page.fill('input[placeholder="Password"], input[type="password"]', CONFIG.klingPassword);
    console.log('Filled password');
    await page.waitForTimeout(500);
    await page.click('button:has-text("Sign In"):not(:has-text("with")), button[type="submit"]');
    console.log('Clicked Sign In button');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'ss8-after-login.png' });

    // Step 7: Click the credit counter in the bottom-left sidebar
    // It shows as "1.9k" or similar next to a green coin icon
    console.log('Looking for credit counter in sidebar...');
    await page.screenshot({ path: 'ss9-looking-for-credits.png' });

    // Click the credit amount shown in the sidebar bottom-left
    const creditSelectors = [
      '[class*="credit"]:has-text("k")',
      '[class*="credit"]:has-text(".")',
      '[class*="coin"]',
      '[class*="balance"]',
      '.sidebar [class*="credit"]',
    ];
    let creditClicked = false;
    for (const sel of creditSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log('Clicked credit selector: ' + sel);
        creditClicked = true;
        break;
      } catch { continue; }
    }

    if (!creditClicked) {
      // Navigate directly to membership page as fallback
      console.log('Could not click credit counter, navigating to membership page...');
      await page.goto('https://kling.ai/app/membership/membership-plan', { waitUntil: 'domcontentloaded' });
    }

    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'ss10-credits-page.png' });

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

  // Look for "Remaining Credits" label followed by a number (from the credit details modal)
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

  // Fallback: look for Credits label then number on next line (membership page)
  let creditsCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === 'credits') {
      creditsCount++;
      if (creditsCount < 2) continue;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (/^\d[\d,]*$/.test(next)) {
          const val = parseInt(next.replace(/,/g, ''));
          console.log('Found credits on membership page: ' + val);
          return val;
        }
      }
    }
  }

  // Last resort: largest 4+ digit number on page
  const allNumbers = bodyText.match(/\b\d{4,}\b/g);
  if (allNumbers) {
    const vals = allNumbers.map(n => parseInt(n)).filter(n => n < 1000000);
    if (vals.length > 0) {
      const max = Math.max(...vals);
      console.log('Last resort credit value: ' + max);
      return max;
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
