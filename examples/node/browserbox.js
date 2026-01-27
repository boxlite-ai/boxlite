/**
 * BrowserBox Example - Browser automation with Playwright Server
 *
 * Demonstrates:
 * - Starting browsers with Playwright Server (chromium, firefox, webkit)
 * - Connection methods: wsEndpoint(), connect()
 * - Multi-browser support
 */

import { BrowserBox } from '@boxlite-ai/boxlite';
import { chromium, firefox, webkit } from 'playwright-core';

const browserTypes = { chromium, firefox, webkit };

async function main() {
  console.log('=== BrowserBox Example (Playwright Server) ===\n');

  // Demo 1: All connection methods
  console.log('1. Connection Methods Demo...\n');
  await connectionMethodsDemo();

  // Demo 2: All browsers work
  console.log('\n2. Multi-Browser Demo (all browsers)...\n');
  await multiBrowserDemo();
}

/**
 * Demonstrates both connection methods:
 * - wsEndpoint() + playwright.connect() - recommended for explicit control
 * - connect() - convenience one-liner
 */
async function connectionMethodsDemo() {
  // Method 1: wsEndpoint() + explicit Playwright connect (RECOMMENDED)
  console.log('   Method 1: wsEndpoint() + playwright.connect()');
  console.log('   (Recommended - gives you explicit control)\n');
  {
    const box = new BrowserBox({ browser: 'chromium' });
    try {
      // Get WebSocket endpoint
      const wsEndpoint = await box.wsEndpoint();
      console.log(`   wsEndpoint: ${wsEndpoint}`);

      // Connect using Playwright directly
      const browser = await chromium.connect(wsEndpoint);
      const page = await browser.newPage();
      await page.goto('https://example.com');
      console.log(`   Page title: ${await page.title()}`);
      await browser.close();
    } finally {
      await box.stop();
    }
  }

  // Method 2: connect() - convenience one-liner
  console.log('\n   Method 2: connect() convenience method');
  console.log('   (One-liner - auto-selects browser type)\n');
  {
    const box = new BrowserBox({ browser: 'chromium' });
    try {
      // One-liner: starts box and returns connected browser
      const browser = await box.connect();
      const page = await browser.newPage();
      await page.goto('https://example.com');
      console.log(`   Page title: ${await page.title()}`);
      await browser.close();
    } finally {
      await box.stop();
    }
  }

  console.log('\n   Both connection methods work!\n');
}

/**
 * Multi-browser demo - tests all browsers with results tracking
 */
async function multiBrowserDemo() {
  const browsers = ['chromium', 'firefox', 'webkit'];
  const results = [];

  for (const browserName of browsers) {
    console.log(`   Testing ${browserName}...`);

    const box = new BrowserBox({
      browser: browserName,
      memoryMib: 2048,
      cpus: 2,
      // Use different ports for parallel testing
      port: 3000 + browsers.indexOf(browserName)
    });

    try {
      const wsEndpoint = await box.wsEndpoint();
      console.log(`   Endpoint: ${wsEndpoint}`);

      // Connect using the matching browser type from Playwright
      const playwright = browserTypes[browserName];
      const browser = await playwright.connect(wsEndpoint);

      const page = await browser.newPage();
      await page.goto('https://example.com');
      const title = await page.title();

      console.log(`   Title: ${title}`);
      await browser.close();

      results.push({ browser: browserName, status: 'PASSED', title });
      console.log(`   ${browserName}: PASSED\n`);
    } catch (error) {
      results.push({ browser: browserName, status: 'FAILED', error: error.message });
      console.log(`   ${browserName}: FAILED - ${error.message}\n`);
    } finally {
      await box.stop();
    }
  }

  // Summary
  console.log('   === SUMMARY ===');
  for (const r of results) {
    console.log(`   ${r.browser}: ${r.status}${r.title ? ` (${r.title})` : ''}`);
  }

  const failed = results.filter(r => r.status === 'FAILED');
  if (failed.length > 0) {
    console.log(`\n   ${failed.length} browser(s) failed`);
    process.exit(1);
  } else {
    console.log('\n   All browsers PASSED!\n');
  }
}

// Run the example
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
