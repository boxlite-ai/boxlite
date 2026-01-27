#!/usr/bin/env python3
"""
BrowserBox Example - Browser automation with Puppeteer (pyppeteer)

Demonstrates connecting to BrowserBox using Puppeteer:
- Navigate to pages and extract content
- Take screenshots
- Fill forms
- Web scraping

Requirements:
    pip install pyppeteer
"""

import asyncio
import boxlite

# Check if pyppeteer is available
try:
    import pyppeteer
    HAS_PYPPETEER = True
except ImportError:
    HAS_PYPPETEER = False
    print("⚠ pyppeteer not installed. Install with: pip install pyppeteer")


async def example_basic_navigation():
    """Example 1: Navigate to a page and extract content."""
    print("\n=== Example 1: Basic Navigation ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.endpoint()
        print(f"✓ BrowserBox ready: {ws_endpoint}")

        if not HAS_PYPPETEER:
            print("  (skipping - pyppeteer not installed)")
            return

        # Connect with Puppeteer
        browser_ctx = await pyppeteer.connect(browserWSEndpoint=ws_endpoint)
        page = await browser_ctx.newPage()

        # Navigate to example.com
        print("  Navigating to example.com...")
        await page.goto("https://example.com")

        # Extract page title
        title = await page.title()
        print(f"  ✓ Page title: {title}")

        # Extract heading using page.evaluate
        heading = await page.evaluate("() => document.querySelector('h1').textContent")
        print(f"  ✓ Heading: {heading}")

        await browser_ctx.close()


async def example_screenshot():
    """Example 2: Take screenshots."""
    print("\n=== Example 2: Screenshots ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.endpoint()

        if not HAS_PYPPETEER:
            print("  (skipping - pyppeteer not installed)")
            return

        browser_ctx = await pyppeteer.connect(browserWSEndpoint=ws_endpoint)
        page = await browser_ctx.newPage()

        # Set viewport size
        await page.setViewport({"width": 1280, "height": 720})

        # Navigate and screenshot
        await page.goto("https://example.com")
        await page.screenshot({"path": "/tmp/pyppeteer_screenshot.png"})
        print("  ✓ Screenshot saved: /tmp/pyppeteer_screenshot.png")

        # Full page screenshot
        await page.screenshot({"path": "/tmp/pyppeteer_fullpage.png", "fullPage": True})
        print("  ✓ Full page screenshot saved: /tmp/pyppeteer_fullpage.png")

        await browser_ctx.close()


async def example_form_interaction():
    """Example 3: Interact with forms."""
    print("\n=== Example 3: Form Interaction ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.endpoint()

        if not HAS_PYPPETEER:
            print("  (skipping - pyppeteer not installed)")
            return

        browser_ctx = await pyppeteer.connect(browserWSEndpoint=ws_endpoint)
        page = await browser_ctx.newPage()

        # Use a demo form site
        print("  Navigating to httpbin.org/forms/post...")
        await page.goto("https://httpbin.org/forms/post")

        # Fill form fields
        await page.type('input[name="custname"]', "John Doe")
        await page.type('input[name="custtel"]', "555-1234")
        await page.type('input[name="custemail"]', "john@example.com")
        await page.type('textarea[name="comments"]', "Test from BrowserBox + pyppeteer")

        # Select pizza size (click radio button)
        await page.click('input[value="medium"]')

        # Select toppings (click checkboxes)
        await page.click('input[value="cheese"]')
        await page.click('input[value="mushroom"]')

        print("  ✓ Form filled successfully")

        # Take screenshot of filled form
        await page.screenshot({"path": "/tmp/pyppeteer_form.png"})
        print("  ✓ Screenshot saved: /tmp/pyppeteer_form.png")

        await browser_ctx.close()


async def example_web_scraping():
    """Example 4: Extract structured data from a page."""
    print("\n=== Example 4: Web Scraping ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.endpoint()

        if not HAS_PYPPETEER:
            print("  (skipping - pyppeteer not installed)")
            return

        browser_ctx = await pyppeteer.connect(browserWSEndpoint=ws_endpoint)
        page = await browser_ctx.newPage()

        # Scrape Hacker News titles
        print("  Scraping Hacker News front page...")
        await page.goto("https://news.ycombinator.com")

        # Extract story titles (first 5) using page.evaluate
        titles = await page.evaluate("""
            () => {
                const links = document.querySelectorAll('.titleline > a');
                return Array.from(links).slice(0, 5).map(a => a.textContent);
            }
        """)

        print("  ✓ Top 5 stories:")
        for i, title in enumerate(titles, 1):
            truncated = title[:60] + "..." if len(title) > 60 else title
            print(f"    {i}. {truncated}")

        await browser_ctx.close()


async def main():
    """Run all examples."""
    print("=" * 60)
    print("BrowserBox Examples - Browser Automation with Puppeteer")
    print("=" * 60)

    await example_basic_navigation()
    await example_screenshot()
    await example_form_interaction()
    await example_web_scraping()

    print("\n" + "=" * 60)
    print("✓ All examples completed!")
    print("\nKey APIs:")
    print("  • BrowserBox() - Create isolated browser sandbox")
    print("  • await endpoint() - Get WebSocket URL for Puppeteer")
    print("  • pyppeteer.connect(browserWSEndpoint=url) - Connect & automate")


if __name__ == "__main__":
    asyncio.run(main())
