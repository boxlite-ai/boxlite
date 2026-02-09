#!/usr/bin/env python3
"""
ComputerBox Example - Desktop Automation

Tests all ComputerBox functions comprehensively.
"""

import asyncio
import base64
import logging
import os
import sys

import boxlite

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from _helpers import setup_logging
except ImportError:
    def setup_logging():
        logging.basicConfig(level=logging.ERROR)

logger = logging.getLogger("computerbox_example")


async def test_all_functions():
    """Test all ComputerBox functions."""
    print("=== ComputerBox - Testing All Functions ===\n")

    async with boxlite.ComputerBox(cpu=2, memory=2048) as desktop:
        # async with boxlite.ComputerBox(cpu=2, memory=2048) as desktop:
        print("✓ Desktop started\n")

        # 1. wait_until_ready()
        print("1. wait_until_ready()")
        await desktop.wait_until_ready(timeout=60)
        print("   ✓ Desktop initialized\n")

        # 2. get_screen_size()
        print("2. get_screen_size()")
        width, height = await desktop.get_screen_size()
        print(f"   ✓ Screen: {width}x{height}\n")

        # 3. screenshot()
        print("3. screenshot()")
        result = await desktop.screenshot()
        print(f"   ✓ Captured: {result['width']}x{result['height']} {result['format']}")
        print(f"   ✓ Data size: {len(result['data'])} bytes\n")

        # 4. mouse_move()
        print("4. mouse_move(x, y)")
        await desktop.mouse_move(512, 384)
        print("   ✓ Moved to (512, 384)\n")

        # 5. cursor_position()
        print("5. cursor_position()")
        x, y = await desktop.cursor_position()
        print(f"   ✓ Cursor at ({x}, {y})\n")

        # 6. left_click()
        print("6. left_click()")
        await desktop.left_click()
        print("   ✓ Clicked\n")

        # 7. right_click()
        print("7. right_click()")
        await desktop.right_click()
        print("   ✓ Right clicked\n")

        # 8. middle_click()
        print("8. middle_click()")
        await desktop.middle_click()
        print("   ✓ Middle clicked\n")

        # 9. double_click()
        print("9. double_click()")
        await desktop.double_click()
        print("   ✓ Double clicked\n")

        # 10. triple_click()
        print("10. triple_click()")
        await desktop.triple_click()
        print("   ✓ Triple clicked\n")

        # 11. left_click_drag()
        print("11. left_click_drag(start_x, start_y, end_x, end_y)")
        await desktop.left_click_drag(100, 100, 200, 200)
        print("   ✓ Dragged from (100,100) to (200,200)\n")

        # 12. type()
        print("12. type(text)")
        await desktop.type("Hello BoxLite!")
        print("   ✓ Typed: 'Hello BoxLite!'\n")

        # 13. key()
        print("13. key(keyname)")
        await desktop.key("Return")
        print("   ✓ Pressed: Return\n")
        await desktop.key("ctrl+a")
        print("   ✓ Pressed: Ctrl+A\n")

        # 14. scroll()
        print("14. scroll(x, y, direction, amount)")
        await desktop.scroll(512, 384, "down", amount=3)
        print("   ✓ Scrolled down 3 units\n")

        print("=" * 50)
        print("✓ All 14 functions tested successfully!")


async def example_workflow():
    """Example workflow: Take screenshots and interact."""
    print("\n\n=== Example Workflow ===\n")

    async with boxlite.ComputerBox(cpu=2, memory=2048) as desktop:
        print("Desktop started\n")

        # Wait for desktop
        await desktop.wait_until_ready()

        # Take initial screenshot
        print("📸 Initial screenshot...")
        img1 = await desktop.screenshot()
        with open("screenshot_1.png", 'wb') as f:
            f.write(base64.b64decode(img1['data']))
        print("   ✓ Saved: screenshot_1.png\n")

        # Interact with desktop
        print("🖱️  Clicking application menu...")
        await desktop.mouse_move(50, 20)
        await desktop.left_click()

        # Take final screenshot
        print("\n📸 Final screenshot...")
        img2 = await desktop.screenshot()
        with open("screenshot_2.png", 'wb') as f:
            f.write(base64.b64decode(img2['data']))
        print("   ✓ Saved: screenshot_2.png\n")

        print("✓ Workflow completed!")


async def main():
    """Run all examples."""
    await test_all_functions()
    await example_workflow()


if __name__ == "__main__":
    setup_logging()
    logger.info("Python logging configured; runtime logs will emit to stdout.")
    asyncio.run(main())
