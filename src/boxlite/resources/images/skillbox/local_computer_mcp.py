#!/usr/bin/env python3
"""
Local Computer MCP Server - Desktop Control for SkillBox.

A simplified MCP server that runs inside SkillBox and controls the local
DISPLAY=:1 directly using xdotool and PIL. No VM creation - direct desktop control.

This allows Claude CLI running inside SkillBox to have computer_use capabilities
(screenshot, mouse, keyboard) against the local XFCE desktop.
"""
import asyncio
import base64
import io
import logging
import os
import subprocess
import sys
from typing import Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import ImageContent, TextContent, Tool

# Configure logging to stderr only (to avoid interfering with MCP stdio protocol)
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("local-computer-mcp")

# Screen resolution (matches SkillBox default)
SCREEN_WIDTH = 1024
SCREEN_HEIGHT = 768

# Display to control
DISPLAY = os.environ.get("DISPLAY", ":1")


def run_xdotool(*args: str) -> str:
    """Run an xdotool command and return its output."""
    cmd = ["xdotool"] + list(args)
    env = os.environ.copy()
    env["DISPLAY"] = DISPLAY
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        if result.returncode != 0:
            raise RuntimeError(f"xdotool failed: {result.stderr}")
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        raise RuntimeError("xdotool command timed out")


def take_screenshot() -> dict:
    """Capture a screenshot of the current display and return base64-encoded PNG."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        temp_path = f.name

    try:
        env = os.environ.copy()
        env["DISPLAY"] = DISPLAY

        # Use scrot to capture screenshot
        result = subprocess.run(
            ["scrot", "-o", temp_path],
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )

        if result.returncode != 0:
            raise RuntimeError(f"Screenshot failed: {result.stderr}")

        # Read the image file
        with open(temp_path, "rb") as f:
            image_data = f.read()

        # Encode as base64
        base64_data = base64.standard_b64encode(image_data).decode("utf-8")

        return {
            "data": base64_data,
            "width": SCREEN_WIDTH,
            "height": SCREEN_HEIGHT,
        }
    except subprocess.TimeoutExpired:
        raise RuntimeError("Screenshot timed out")
    finally:
        # Always clean up temp file
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def mouse_move(x: int, y: int) -> None:
    """Move mouse cursor to specified coordinates."""
    run_xdotool("mousemove", str(x), str(y))


def left_click() -> None:
    """Click the left mouse button."""
    run_xdotool("click", "1")


def right_click() -> None:
    """Click the right mouse button."""
    run_xdotool("click", "3")


def middle_click() -> None:
    """Click the middle mouse button."""
    run_xdotool("click", "2")


def double_click() -> None:
    """Double-click the left mouse button."""
    run_xdotool("click", "--repeat", "2", "--delay", "100", "1")


def triple_click() -> None:
    """Triple-click the left mouse button."""
    run_xdotool("click", "--repeat", "3", "--delay", "100", "1")


def left_click_drag(start_x: int, start_y: int, end_x: int, end_y: int) -> None:
    """Click and drag from start to end coordinates."""
    # Move to start position
    run_xdotool("mousemove", str(start_x), str(start_y))
    # Press and hold left button, move to end, release
    run_xdotool("mousedown", "1")
    run_xdotool("mousemove", str(end_x), str(end_y))
    run_xdotool("mouseup", "1")


def type_text(text: str) -> None:
    """Type text using the keyboard."""
    # Use --delay for reliability
    run_xdotool("type", "--delay", "50", text)


def press_key(key: str) -> None:
    """Press a key or key combination (e.g., 'Return', 'ctrl+c', 'alt+Tab')."""
    run_xdotool("key", key)


def scroll(x: int, y: int, direction: str, amount: int = 3) -> None:
    """Scroll at the specified coordinates.

    xdotool button mapping:
    - 4: scroll up
    - 5: scroll down
    - 6: scroll left
    - 7: scroll right
    """
    # Move to scroll position
    run_xdotool("mousemove", str(x), str(y))

    button_map = {
        "up": "4",
        "down": "5",
        "left": "6",
        "right": "7",
    }
    button = button_map.get(direction.lower())
    if not button:
        raise ValueError(f"Invalid scroll direction: {direction}")

    # Click the scroll button multiple times
    run_xdotool("click", "--repeat", str(amount), "--delay", "50", button)


def cursor_position() -> tuple[int, int]:
    """Get the current cursor position."""
    output = run_xdotool("getmouselocation")
    # Output format: "x:123 y:456 screen:0 window:12345678"
    parts = {}
    for part in output.split():
        if ":" in part:
            key, value = part.split(":", 1)
            parts[key] = value

    x = int(parts.get("x", 0))
    y = int(parts.get("y", 0))
    return x, y


def _validate_coordinate(coordinate: list[int], name: str = "coordinate") -> tuple[int, int]:
    """Validate and unpack a coordinate pair.

    Args:
        coordinate: [x, y] list
        name: Parameter name for error messages

    Returns:
        Tuple of (x, y)

    Raises:
        ValueError: If coordinate is invalid or out of bounds
    """
    if not isinstance(coordinate, (list, tuple)) or len(coordinate) != 2:
        raise ValueError(f"{name} must be [x, y], got: {coordinate}")
    x, y = int(coordinate[0]), int(coordinate[1])
    if not (0 <= x <= SCREEN_WIDTH) or not (0 <= y <= SCREEN_HEIGHT):
        raise ValueError(
            f"{name} ({x}, {y}) out of bounds (0-{SCREEN_WIDTH}, 0-{SCREEN_HEIGHT})"
        )
    return x, y


class LocalComputerHandler:
    """Handler for local computer control actions."""

    async def screenshot(self, **kwargs) -> dict:
        """Capture screenshot."""
        return await asyncio.to_thread(take_screenshot)

    async def mouse_move(self, coordinate: list[int], **kwargs) -> dict:
        """Move mouse to coordinates."""
        x, y = _validate_coordinate(coordinate)
        await asyncio.to_thread(mouse_move, x, y)
        return {"success": True}

    async def left_click(self, coordinate: Optional[list[int]] = None, **kwargs) -> dict:
        """Click left mouse button."""
        if coordinate:
            x, y = _validate_coordinate(coordinate)
            await asyncio.to_thread(mouse_move, x, y)
        await asyncio.to_thread(left_click)
        return {"success": True}

    async def right_click(self, coordinate: Optional[list[int]] = None, **kwargs) -> dict:
        """Click right mouse button."""
        if coordinate:
            x, y = _validate_coordinate(coordinate)
            await asyncio.to_thread(mouse_move, x, y)
        await asyncio.to_thread(right_click)
        return {"success": True}

    async def middle_click(self, coordinate: Optional[list[int]] = None, **kwargs) -> dict:
        """Click middle mouse button."""
        if coordinate:
            x, y = _validate_coordinate(coordinate)
            await asyncio.to_thread(mouse_move, x, y)
        await asyncio.to_thread(middle_click)
        return {"success": True}

    async def double_click(self, coordinate: Optional[list[int]] = None, **kwargs) -> dict:
        """Double click left mouse button."""
        if coordinate:
            x, y = _validate_coordinate(coordinate)
            await asyncio.to_thread(mouse_move, x, y)
        await asyncio.to_thread(double_click)
        return {"success": True}

    async def triple_click(self, coordinate: Optional[list[int]] = None, **kwargs) -> dict:
        """Triple click left mouse button."""
        if coordinate:
            x, y = _validate_coordinate(coordinate)
            await asyncio.to_thread(mouse_move, x, y)
        await asyncio.to_thread(triple_click)
        return {"success": True}

    async def left_click_drag(self, start_coordinate: list[int], end_coordinate: list[int], **kwargs) -> dict:
        """Drag from start to end coordinates."""
        start_x, start_y = _validate_coordinate(start_coordinate, "start_coordinate")
        end_x, end_y = _validate_coordinate(end_coordinate, "end_coordinate")
        await asyncio.to_thread(left_click_drag, start_x, start_y, end_x, end_y)
        return {"success": True}

    async def type(self, text: str, **kwargs) -> dict:
        """Type text."""
        await asyncio.to_thread(type_text, text)
        return {"success": True}

    async def key(self, key: str, **kwargs) -> dict:
        """Press key or key combination."""
        await asyncio.to_thread(press_key, key)
        return {"success": True}

    async def scroll(self, coordinate: list[int], scroll_direction: str, scroll_amount: int = 3, **kwargs) -> dict:
        """Scroll at coordinates."""
        x, y = _validate_coordinate(coordinate)
        await asyncio.to_thread(scroll, x, y, scroll_direction, scroll_amount)
        return {"success": True}

    async def cursor_position(self, **kwargs) -> dict:
        """Get current cursor position."""
        x, y = await asyncio.to_thread(cursor_position)
        return {"x": x, "y": y}


async def main():
    """Main entry point for the MCP server."""
    logger.info("Starting Local Computer MCP Server")
    logger.info(f"Controlling display: {DISPLAY}")

    # Create handler and server
    handler = LocalComputerHandler()
    server = Server("local-computer")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        """List available tools."""
        return [
            Tool(
                name="computer",
                description="""Control the desktop environment.

This tool allows you to interact with the desktop using mouse and keyboard, take screenshots, and browse the web just like a human. The desktop is an Ubuntu environment with XFCE.

Actions:
- screenshot: Capture the current screen (returns image)
- mouse_move: Move cursor to coordinates [x, y]
- left_click: Click left mouse button (optionally at coordinate)
- right_click: Click right mouse button (optionally at coordinate)
- middle_click: Click middle mouse button (optionally at coordinate)
- double_click: Double-click left button (optionally at coordinate)
- triple_click: Triple-click left button (optionally at coordinate)
- left_click_drag: Click and drag from start_coordinate to end_coordinate
- type: Type text using keyboard
- key: Press key or key combination (e.g., 'Return', 'ctrl+c', 'alt+Tab')
- scroll: Scroll in a direction at coordinate
- cursor_position: Get current cursor position

Coordinates use [x, y] format with origin at top-left (0, 0).
Screen resolution is 1024x768 pixels.

IMPORTANT: Always take a screenshot first to see the current state before taking action.""",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "screenshot",
                                "mouse_move",
                                "left_click",
                                "right_click",
                                "middle_click",
                                "double_click",
                                "triple_click",
                                "left_click_drag",
                                "type",
                                "key",
                                "scroll",
                                "cursor_position",
                            ],
                            "description": "The action to perform",
                        },
                        "coordinate": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "minItems": 2,
                            "maxItems": 2,
                            "description": "Coordinates [x, y] for click/move/scroll actions",
                        },
                        "text": {
                            "type": "string",
                            "description": "Text to type (for 'type' action)",
                        },
                        "key": {
                            "type": "string",
                            "description": "Key to press (for 'key' action), e.g., 'Return', 'Escape', 'ctrl+c'",
                        },
                        "scroll_direction": {
                            "type": "string",
                            "enum": ["up", "down", "left", "right"],
                            "description": "Direction to scroll (for 'scroll' action)",
                        },
                        "scroll_amount": {
                            "type": "integer",
                            "description": "Number of scroll units (default: 3)",
                            "default": 3,
                        },
                        "start_coordinate": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "Starting coordinates for 'left_click_drag'",
                        },
                        "end_coordinate": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "Ending coordinates for 'left_click_drag'",
                        },
                    },
                    "required": ["action"],
                },
            )
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent | ImageContent]:
        """Handle tool calls."""
        if name != "computer":
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

        action = arguments.get("action")
        if not action:
            return [TextContent(type="text", text="Missing 'action' parameter")]

        logger.info(f"Action: {action} with args: {arguments}")

        try:
            # Get the handler method for this action
            action_handler = getattr(handler, action, None)
            if not action_handler:
                return [TextContent(type="text", text=f"Unknown action: {action}")]

            result = await action_handler(**arguments)

            # Format response based on action
            if action == "screenshot":
                return [
                    ImageContent(
                        type="image",
                        data=result["data"],
                        mimeType="image/png",
                    )
                ]
            elif action == "cursor_position":
                x, y = result["x"], result["y"]
                return [
                    TextContent(
                        type="text",
                        text=f"Cursor position: [{x}, {y}]",
                    )
                ]
            elif action == "mouse_move":
                coord = arguments.get("coordinate", [])
                return [
                    TextContent(
                        type="text",
                        text=f"Moved cursor to {coord}",
                    )
                ]
            elif action in ["left_click", "right_click", "middle_click"]:
                coord = arguments.get("coordinate")
                if coord:
                    return [
                        TextContent(
                            type="text",
                            text=f"Moved to {coord} and clicked {action.replace('_', ' ')}",
                        )
                    ]
                else:
                    return [
                        TextContent(
                            type="text",
                            text=f"Clicked {action.replace('_', ' ')}",
                        )
                    ]
            elif action in ["double_click", "triple_click"]:
                coord = arguments.get("coordinate")
                if coord:
                    return [
                        TextContent(
                            type="text",
                            text=f"Moved to {coord} and {action.replace('_', ' ')}ed",
                        )
                    ]
                else:
                    return [
                        TextContent(
                            type="text",
                            text=f"{action.replace('_', ' ').capitalize()}ed",
                        )
                    ]
            elif action == "left_click_drag":
                start = arguments.get("start_coordinate", [])
                end = arguments.get("end_coordinate", [])
                return [
                    TextContent(
                        type="text",
                        text=f"Dragged from {start} to {end}",
                    )
                ]
            elif action == "type":
                text = arguments.get("text", "")
                preview = text[:50] + "..." if len(text) > 50 else text
                return [
                    TextContent(
                        type="text",
                        text=f"Typed: {preview}",
                    )
                ]
            elif action == "key":
                key = arguments.get("key", "")
                return [
                    TextContent(
                        type="text",
                        text=f"Pressed key: {key}",
                    )
                ]
            elif action == "scroll":
                direction = arguments.get("scroll_direction", "")
                amount = arguments.get("scroll_amount", 3)
                coord = arguments.get("coordinate", [])
                return [
                    TextContent(
                        type="text",
                        text=f"Scrolled {direction} {amount} units at {coord}",
                    )
                ]
            else:
                return [
                    TextContent(
                        type="text",
                        text=f"Action completed: {action}",
                    )
                ]

        except Exception as e:
            logger.error(f"Tool execution error: {e}", exc_info=True)
            return [
                TextContent(
                    type="text",
                    text=f"Error executing {action}: {str(e)}",
                )
            ]

    # Run the server
    try:
        async with stdio_server() as streams:
            logger.info("MCP server running on stdio")
            await server.run(
                streams[0],
                streams[1],
                server.create_initialization_options(),
            )
    except KeyboardInterrupt:
        logger.info("Server interrupted by user")
    except Exception as e:
        if isinstance(e, (SystemExit, GeneratorExit)):
            raise
        logger.error(f"Server error: {e}", exc_info=True)


def run():
    """Sync entry point for CLI."""
    import anyio
    anyio.run(main)


if __name__ == "__main__":
    run()
