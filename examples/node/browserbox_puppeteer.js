/**
 * BrowserBox Example - Browser automation with Puppeteer
 *
 * Demonstrates connecting to BrowserBox using Puppeteer:
 * - Navigate to pages and extract content
 * - Take screenshots
 * - Fill forms
 * - Web scraping
 *
 * Requirements:
 *   npm install puppeteer-core
 */

import { BrowserBox } from '@boxlite-ai/boxlite';
import puppeteer from 'puppeteer-core';

/**
 * Helper: Navigate with retry for transient network errors
 *
 * VM network may not be fully stable when the browser first connects.
 * Retrying navigation handles race conditions during VM startup.
 */
async function gotoWithRetry(page, url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, ...options });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`  Retry ${i + 1}/${retries} after error: ${err.message.split('\n')[0]}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function main() {
  console.log('=== BrowserBox + Puppeteer Example ===\n');

  await exampleBasicNavigation();
  await exampleFirefoxNavigation();
  await exampleScreenshot();
  await exampleFormInteraction();
  await exampleWebScraping();

  console.log('\n=== All examples completed! ===');
  console.log('\nKey APIs:');
  console.log('  • new BrowserBox() - Create isolated browser sandbox');
  console.log('  • await box.endpoint() - Get WebSocket URL for Puppeteer (chromium/firefox)');
  console.log('  • puppeteer.connect({ browserWSEndpoint }) - Connect & automate');
}

/**
 * Example 1: Navigate to a page and extract content
 */
async function exampleBasicNavigation() {
  console.log('--- Example 1: Basic Navigation ---\n');

  const box = new BrowserBox({ browser: 'chromium' });
  try {
    const wsEndpoint = await box.endpoint();
    console.log(`BrowserBox ready: ${wsEndpoint}`);

    // Connect with Puppeteer
    const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const page = await browser.newPage();

    // Navigate to example.com (with retry for transient network errors)
    console.log('Navigating to example.com...');
    await gotoWithRetry(page, 'https://example.com');

    // Extract page title
    const title = await page.title();
    console.log(`✓ Page title: ${title}`);

    // Extract heading using page.evaluate
    const heading = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      return h1 ? h1.textContent : null;
    });
    console.log(`✓ Heading: ${heading}`);

    await browser.close();
  } finally {
    await box.stop();
  }
}

/**
 * Example 2: Firefox with WebDriver BiDi
 *
 * Note: Firefox headless has a limitation where browsingContext.create with
 * type='tab' hangs. Instead, use the existing page that Firefox opens on startup.
 */
async function exampleFirefoxNavigation() {
  console.log('\n--- Example 2: Firefox (WebDriver BiDi) ---\n');

  const box = new BrowserBox({ browser: 'firefox' });
  try {
    const wsEndpoint = await box.endpoint();
    console.log(`Firefox BrowserBox ready: ${wsEndpoint}`);

    // Connect with Puppeteer using WebDriver BiDi protocol
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      protocol: 'webDriverBiDi',
      protocolTimeout: 60000
    });

    // Firefox headless: use existing page instead of newPage()
    // (newPage() triggers browsingContext.create with type='tab' which hangs)
    const pages = await browser.pages();
    const page = pages[0];

    // Navigate to example.com (with retry for transient network errors)
    console.log('Navigating to example.com with Firefox...');
    await gotoWithRetry(page, 'https://example.com');

    // Extract page title
    const title = await page.title();
    console.log(`✓ Page title: ${title}`);

    await browser.close();
  } finally {
    await box.stop();
  }
}

/**
 * Example 3: Take screenshots (Chromium)
 */
async function exampleScreenshot() {
  console.log('\n--- Example 3: Screenshots ---\n');

  const box = new BrowserBox({ browser: 'chromium' });
  try {
    const wsEndpoint = await box.endpoint();

    const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const page = await browser.newPage();

    // Set viewport size
    await page.setViewport({ width: 1280, height: 720 });

    // Navigate and screenshot (with retry for transient network errors)
    await gotoWithRetry(page, 'https://example.com');
    await page.screenshot({ path: '/tmp/puppeteer_screenshot.png' });
    console.log('✓ Screenshot saved: /tmp/puppeteer_screenshot.png');

    // Full page screenshot
    await page.screenshot({ path: '/tmp/puppeteer_fullpage.png', fullPage: true });
    console.log('✓ Full page screenshot saved: /tmp/puppeteer_fullpage.png');

    await browser.close();
  } finally {
    await box.stop();
  }
}

/**
 * Example 4: Interact with forms
 */
async function exampleFormInteraction() {
  console.log('\n--- Example 4: Form Interaction ---\n');

  const box = new BrowserBox({ browser: 'chromium' });
  try {
    const wsEndpoint = await box.endpoint();

    const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const page = await browser.newPage();

    // Use a demo form site
    console.log('Navigating to httpbin.org/forms/post...');
    await gotoWithRetry(page, 'https://httpbin.org/forms/post');

    // Fill form fields
    await page.type('input[name="custname"]', 'John Doe');
    await page.type('input[name="custtel"]', '555-1234');
    await page.type('input[name="custemail"]', 'john@example.com');
    await page.type('textarea[name="comments"]', 'Test comment from BrowserBox + Puppeteer');

    // Select pizza size (click radio button)
    await page.click('input[value="medium"]');

    // Select toppings (click checkboxes)
    await page.click('input[value="cheese"]');
    await page.click('input[value="mushroom"]');

    console.log('✓ Form filled successfully');

    // Take screenshot of filled form
    await page.screenshot({ path: '/tmp/puppeteer_form.png' });
    console.log('✓ Screenshot saved: /tmp/puppeteer_form.png');

    await browser.close();
  } finally {
    await box.stop();
  }
}

/**
 * Example 5: Extract structured data from a page
 */
async function exampleWebScraping() {
  console.log('\n--- Example 5: Web Scraping ---\n');

  const box = new BrowserBox({ browser: 'chromium' });
  try {
    const wsEndpoint = await box.endpoint();

    const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const page = await browser.newPage();

    // Scrape Hacker News titles
    console.log('Scraping Hacker News front page...');
    await gotoWithRetry(page, 'https://news.ycombinator.com');

    // Extract story titles (first 5) using page.evaluate
    const titles = await page.evaluate(() => {
      const links = document.querySelectorAll('.titleline > a');
      return Array.from(links).slice(0, 5).map(a => a.textContent);
    });

    console.log('✓ Top 5 stories:');
    titles.forEach((title, i) => {
      const truncated = title.length > 60 ? title.slice(0, 60) + '...' : title;
      console.log(`  ${i + 1}. ${truncated}`);
    });

    await browser.close();
  } finally {
    await box.stop();
  }
}

// Run the example
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
