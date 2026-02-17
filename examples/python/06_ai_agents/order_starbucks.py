#!/usr/bin/env python3
"""
Starbucks Browser Ordering Example

Demonstrates Claude Code using computer_use tools to navigate
Starbucks.com and simulate ordering coffee, with GUI monitoring.

This example showcases:
- SkillBox with desktop GUI (noVNC) for visual monitoring
- Claude's computer_use tools (mouse, keyboard, screenshot)
- Real-time observation through web browser

Prerequisites:
    1. boxlite Python SDK installed
    2. CLAUDE_CODE_OAUTH_TOKEN environment variable set
    3. Build SkillBox image: make skillbox-image

Usage:
    export CLAUDE_CODE_OAUTH_TOKEN="your-token"
    python starbucks_order_example.py

    Then open http://localhost:3000 to watch Claude work!
"""

import asyncio
import logging
import os
import sys
import time

import boxlite


# =============================================================================
# Display Helpers
# =============================================================================

def print_banner(title: str):
    """Print a prominent banner with title."""
    print()
    print("=" * 60)
    print(f"  {title}")
    print("=" * 60)
    print()


def print_section(title: str):
    """Print a section header."""
    print()
    print(f"── {title} ──")
    print()


def print_info(message: str):
    """Print an info message."""
    print(f"  {message}")


def print_calling(http_port: int, https_port: int):
    print_banner("Calling skill box as function")
    """Print GUI monitoring URLs."""
    print_info(f"HTTP:  http://localhost:{http_port}")
    print_info(f"HTTPS: https://localhost:{https_port}")
    print()
    print_info("Open the URL above in your browser to watch Agent work!")
    print_info("You'll see the desktop environment with Chromium browser.")
    print()


def print_welcome():
    """Print welcome message."""
    print_banner("Starbucks Browser Ordering Demo")
    print_info("Demonstrates Claude navigating a website using computer_use")
    print_info("tools inside a sandboxed SkillBox with real-time GUI monitoring.")


def print_setup_required():
    """Print setup instructions when token is missing."""
    print_section("Setup Required")
    print_info("CLAUDE_CODE_OAUTH_TOKEN environment variable not set")
    print()
    print_info("To run this example:")
    print_info("  1. Get your OAuth token from Claude Code CLI")
    print_info("  2. export CLAUDE_CODE_OAUTH_TOKEN='your-token'")
    print_info("  3. python starbucks_order_example.py")


async def call_with_progress(box, prompt: str) -> str:
    """Call SkillBox with animated progress indicator."""
    task = asyncio.create_task(box.call(prompt))
    dots = 0
    while not task.done():
        dots = (dots % 3) + 1
        print(f"\r  Processing{'.' * dots}{' ' * (3 - dots)}", end="", flush=True)
        await asyncio.sleep(0.5)
    print(f"\r  Processing... done!{' ' * 10}")
    return await task


# =============================================================================
# Configuration
# =============================================================================

def get_oauth_token() -> str | None:
    """Get OAuth token from environment."""
    return os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")


def get_oci_layout_path() -> str:
    """Get path to local OCI layout."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    return os.path.join(project_root, "target", "boxlite-skillbox")


# =============================================================================
# Demo Prompts
# =============================================================================

DEMO_PROMPT = """
Buy Caffè Americano on Starbucks.com, pause at payment step.
"""


# =============================================================================
# Main Demo
# =============================================================================

async def run_demo():
    """Run the Starbucks browser ordering demo."""
    print_welcome()

    oauth_token = get_oauth_token()
    if not oauth_token:
        print_setup_required()
        return

    async with boxlite.SkillBox(
            oauth_token=oauth_token,
            memory_mib=4096,
            name="starbucks-demo",
            # rootfs_path=get_oci_layout_path(),
    ) as box:
        # Wait for desktop
        await box.wait_until_ready()
        print_calling(box.gui_http_port, box.gui_https_port)

        result = await box.call("""
Buy Caffè Americano on Starbucks.com, pause at payment step.
        """)

        print_banner("Claude's Response")
        print(result)


def main():
    """Entry point."""
    logging.basicConfig(
        level=logging.ERROR,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    asyncio.run(run_demo())


if __name__ == "__main__":
    main()
