#!/usr/bin/env python3
"""
BrowserBox Example - Secure Web Automation with Playwright

Demonstrates real browser automation in isolated sandbox:
- Navigate to websites and extract content
- Take screenshots
- Fill forms and click buttons
- Cross-browser testing

Requirements:
    pip install playwright
    playwright install chromium  # or firefox, webkit
"""

import asyncio
import boxlite

# Check if playwright is available
try:
    from playwright.async_api import async_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False
    print("⚠ Playwright not installed. Install with: pip install playwright")
    print("  Then run: playwright install chromium")


async def example_basic_navigation():
    """Example 1: Navigate to a page and extract content."""
    print("\n=== Example 1: Basic Navigation ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.playwright_endpoint()
        print(f"✓ BrowserBox ready: {ws_endpoint}")

        if not HAS_PLAYWRIGHT:
            print("  (skipping browser interaction - playwright not installed)")
            return

        async with async_playwright() as p:
            # Connect to the isolated browser
            browser_ctx = await p.chromium.connect(ws_endpoint)
            page = await browser_ctx.new_page()

            # Navigate to example.com
            print("  Navigating to example.com...")
            await page.goto("https://example.com")

            # Extract page title and content
            title = await page.title()
            heading = await page.locator("h1").text_content()

            print(f"  ✓ Page title: {title}")
            print(f"  ✓ Heading: {heading}")

            await browser_ctx.close()


async def example_screenshot():
    """Example 2: Take screenshots."""
    print("\n=== Example 2: Screenshots ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.playwright_endpoint()

        if not HAS_PLAYWRIGHT:
            print("  (skipping - playwright not installed)")
            return

        async with async_playwright() as p:
            browser_ctx = await p.chromium.connect(ws_endpoint)
            page = await browser_ctx.new_page()

            # Set viewport size
            await page.set_viewport_size({"width": 1280, "height": 720})

            # Navigate and screenshot
            await page.goto("https://example.com")
            await page.screenshot(path="/tmp/example_screenshot.png")
            print("  ✓ Screenshot saved: /tmp/example_screenshot.png")

            # Full page screenshot
            await page.screenshot(path="/tmp/example_fullpage.png", full_page=True)
            print("  ✓ Full page screenshot saved: /tmp/example_fullpage.png")

            await browser_ctx.close()


async def example_form_interaction():
    """Example 3: Interact with forms and buttons."""
    print("\n=== Example 3: Form Interaction ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.playwright_endpoint()

        if not HAS_PLAYWRIGHT:
            print("  (skipping - playwright not installed)")
            return

        async with async_playwright() as p:
            browser_ctx = await p.chromium.connect(ws_endpoint)
            page = await browser_ctx.new_page()

            # Use a demo form site
            print("  Navigating to httpbin.org/forms/post...")
            await page.goto("https://httpbin.org/forms/post")

            # Fill form fields
            await page.fill('input[name="custname"]', "John Doe")
            await page.fill('input[name="custtel"]', "555-1234")
            await page.fill('input[name="custemail"]', "john@example.com")
            await page.fill('textarea[name="comments"]', "Test comment from BrowserBox")

            # Select pizza size
            await page.check('input[value="medium"]')

            # Select toppings
            await page.check('input[value="cheese"]')
            await page.check('input[value="mushroom"]')

            print("  ✓ Form filled successfully")

            # Take screenshot of filled form
            await page.screenshot(path="/tmp/form_filled.png")
            print("  ✓ Screenshot saved: /tmp/form_filled.png")

            await browser_ctx.close()


async def example_web_scraping():
    """Example 4: Extract structured data from a page."""
    print("\n=== Example 4: Web Scraping ===")

    async with boxlite.BrowserBox() as browser:
        ws_endpoint = await browser.playwright_endpoint()

        if not HAS_PLAYWRIGHT:
            print("  (skipping - playwright not installed)")
            return

        async with async_playwright() as p:
            browser_ctx = await p.chromium.connect(ws_endpoint)
            page = await browser_ctx.new_page()

            # Scrape Hacker News titles
            print("  Scraping Hacker News front page...")
            await page.goto("https://news.ycombinator.com")

            # Extract story titles (first 5)
            titles = await page.locator(".titleline > a").all_text_contents()

            print("  ✓ Top 5 stories:")
            for i, title in enumerate(titles[:5], 1):
                print(f"    {i}. {title[:60]}{'...' if len(title) > 60 else ''}")

            await browser_ctx.close()


async def example_cross_browser():
    """Example 5: Cross-browser testing."""
    print("\n=== Example 5: Cross-Browser Testing ===")

    browsers_to_test = [
        ("chromium", 3000),
        ("firefox", 3001),
    ]

    results = {}

    for browser_type, port in browsers_to_test:
        opts = boxlite.BrowserBoxOptions(browser=browser_type, port=port)

        async with boxlite.BrowserBox(opts) as browser:
            ws_endpoint = await browser.playwright_endpoint()
            print(f"  Testing {browser_type}...")

            if not HAS_PLAYWRIGHT:
                results[browser_type] = "skipped"
                continue

            async with async_playwright() as p:
                # Get the right browser launcher
                launcher = getattr(p, browser_type)
                browser_ctx = await launcher.connect(ws_endpoint)
                page = await browser_ctx.new_page()

                # Test: navigate and get user agent
                await page.goto("https://httpbin.org/user-agent")
                content = await page.content()

                # Check if browser name appears in user-agent
                if browser_type in content.lower() or "mozilla" in content.lower():
                    results[browser_type] = "✓ passed"
                else:
                    results[browser_type] = "✗ failed"

                await browser_ctx.close()

    print("\n  Results:")
    for browser_type, result in results.items():
        print(f"    {browser_type}: {result}")


async def main():
    """Run all examples."""
    print("=" * 60)
    print("BrowserBox Examples - Secure Web Automation with Playwright")
    print("=" * 60)

    await example_basic_navigation()
    await example_screenshot()
    await example_form_interaction()
    await example_web_scraping()
    await example_cross_browser()

    print("\n" + "=" * 60)
    print("✓ All examples completed!")
    print("\nKey APIs:")
    print("  • BrowserBox() - Create isolated browser sandbox")
    print("  • await playwright_endpoint() - Get Playwright WebSocket URL")
    print("  • playwright.chromium.connect(ws_endpoint) - Connect & automate")


if __name__ == "__main__":
    asyncio.run(main())
