#!/usr/bin/env python3
"""
Multi-turn Claude CLI Example in BoxLite

This example demonstrates how to run Claude Code CLI inside a boxlite VM
and communicate with it via stdin/stdout using the stream-json format.

Prerequisites:
1. boxlite Python SDK installed
2. OAuth token set: export CLAUDE_CODE_OAUTH_TOKEN="your-token"

Usage:
    python claude_in_boxlite_example.py
"""
import asyncio
import json
import logging
import os
import sys

import boxlite

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from _helpers import setup_logging as _base_setup_logging
except ImportError:
    def _base_setup_logging(**_):
        logging.basicConfig(level=logging.INFO)

logger = logging.getLogger("claude_in_boxlite_example")


def setup_logging():
    """Configure logging; uses INFO by default, set LOGLEVEL=DEBUG for verbose."""
    level = os.environ.get("LOGLEVEL", "INFO").upper()
    _base_setup_logging(level=getattr(logging, level, logging.INFO))


# Configuration
BOX_NAME = "claude-box"
OAUTH_TOKEN = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")

# ANSI color codes for beautiful output
COLORS = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "dim": "\033[2m",
    "cyan": "\033[36m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "red": "\033[31m",
    "magenta": "\033[35m",
    "blue": "\033[34m",
}


def display_message(msg: dict, show_debug: bool = False):
    """Display a Claude message beautifully.

    Args:
        msg: Parsed JSON message from Claude CLI
        show_debug: If True, show all message types; if False, only show user-relevant ones
    """
    msg_type = msg.get("type", "unknown")
    c = COLORS

    if msg_type == "system":
        if show_debug:
            subtype = msg.get("subtype", "")
            print(f"{c['dim']}[system:{subtype}]{c['reset']}")

    elif msg_type == "assistant":
        message = msg.get("message", {})
        content_list = message.get("content", [])

        for content in content_list:
            content_type = content.get("type", "")

            if content_type == "text":
                text = content.get("text", "")
                if text:
                    print(f"{c['cyan']}{text}{c['reset']}", flush=True)

            elif content_type == "tool_use":
                tool_name = content.get("name", "unknown")
                tool_input = content.get("input", {})

                print(f"\n{c['yellow']}[Tool: {tool_name}]{c['reset']}")

                # Format tool input based on tool type
                if tool_name == "Write":
                    file_path = tool_input.get("file_path", "")
                    content_preview = tool_input.get("content", "")[:200]
                    print(f"  {c['dim']}Writing to: {file_path}{c['reset']}")
                    if content_preview:
                        lines = content_preview.split('\n')[:5]
                        for line in lines:
                            print(f"  {c['dim']}| {line}{c['reset']}")
                        if len(tool_input.get("content", "")) > 200:
                            print(f"  {c['dim']}| ...{c['reset']}")

                elif tool_name == "Bash":
                    cmd = tool_input.get("command", "")
                    desc = tool_input.get("description", "")
                    print(f"  {c['dim']}$ {cmd}{c['reset']}")
                    if desc:
                        print(f"  {c['dim']}({desc}){c['reset']}")

                elif tool_name == "Read":
                    file_path = tool_input.get("file_path", "")
                    print(f"  {c['dim']}Reading: {file_path}{c['reset']}")

                elif tool_name == "Edit":
                    file_path = tool_input.get("file_path", "")
                    print(f"  {c['dim']}Editing: {file_path}{c['reset']}")

                else:
                    # Generic tool display
                    for key, value in list(tool_input.items())[:3]:
                        val_str = str(value)[:80]
                        print(f"  {c['dim']}{key}: {val_str}{c['reset']}")

    elif msg_type == "user":
        # Tool results
        message = msg.get("message", {})
        content_list = message.get("content", [])

        for content in content_list:
            if content.get("type") == "tool_result":
                is_error = content.get("is_error", False)
                result_text = content.get("content", "")[:150]

                if is_error:
                    print(f"  {c['red']}Error: {result_text}{c['reset']}")
                elif show_debug:
                    print(f"  {c['green']}OK{c['reset']}")

    elif msg_type == "result":
        is_error = msg.get("is_error", False)
        duration_ms = msg.get("duration_ms", 0)
        cost = msg.get("total_cost_usd", 0)

        if is_error:
            error_msg = msg.get("result", "Unknown error")
            print(f"\n{c['red']}Error: {error_msg}{c['reset']}")

        # Show stats (result text already shown via assistant messages)
        print(f"{c['dim']}[Completed in {duration_ms/1000:.1f}s | Cost: ${cost:.4f}]{c['reset']}")


async def setup_claude_box(runtime):
    """Create or reuse a persistent box with Claude CLI installed."""

    # Try to get existing box
    box = await runtime.get(BOX_NAME)
    if box:
        print(f"Found existing {BOX_NAME}")
        await box.__aenter__()

        # Check if Claude is installed
        execution = await box.exec("which", ["claude"], None)
        stdout = execution.stdout()
        output = []
        async for line in stdout:
            output.append(line.decode() if isinstance(line, bytes) else line)
        result = await execution.wait()

        if result.exit_code == 0:
            print(f"Claude found at: {''.join(output).strip()}")
            return box
        print("Claude not installed, will install...")
    else:
        # Create new persistent box
        from boxlite import BoxOptions
        options = BoxOptions(
            image="node:20-alpine",
            memory_mib=2048,
            disk_size_gb=5,
            auto_remove=False,  # Persist after exit
            env=[("CLAUDE_CODE_OAUTH_TOKEN", OAUTH_TOKEN)]
        )
        print(f"Creating new box: {BOX_NAME}")
        box = await runtime.create(options, name=BOX_NAME)
        await box.__aenter__()

    # Install Claude CLI
    print("Installing Claude CLI (this may take a few minutes)...")
    execution = await box.exec("npm", ["install", "-g", "@anthropic-ai/claude-code"], None)
    stdout = execution.stdout()
    async for line in stdout:
        print(line.decode() if isinstance(line, bytes) else line, end='')
    result = await execution.wait()

    if result.exit_code != 0:
        raise RuntimeError("Failed to install Claude CLI")

    # Verify installation
    execution = await box.exec("claude", ["--version"], None)
    stdout = execution.stdout()
    version = []
    async for line in stdout:
        version.append(line.decode() if isinstance(line, bytes) else line)
    await execution.wait()
    print(f"Installed: {''.join(version).strip()}")

    return box


def parse_ndjson(data: str) -> list:
    """Parse newline-delimited JSON."""
    results = []
    lines = data.strip().split('\n')
    logger.debug("parse_ndjson: Input data (%d chars), %d lines", len(data), len(lines))
    for i, line in enumerate(lines):
        line = line.strip()
        if line:
            try:
                parsed = json.loads(line)
                results.append(parsed)
                msg_type = parsed.get("type", "unknown")
                logger.debug("parse_ndjson: Line %d: type=%s", i, msg_type)
            except json.JSONDecodeError as e:
                logger.debug("parse_ndjson: Line %d: PARSE ERROR: %s", i, e)
                logger.debug("parse_ndjson: Raw line: %s...", line[:100])
    logger.debug("parse_ndjson: Parsed %d messages", len(results))
    return results


async def send_message(stdin, stdout, content: str, session_id: str = "default",
                       display: bool = True):
    """Send a message and wait for response.

    Args:
        stdin: Process stdin handle
        stdout: Process stdout handle
        content: Message content to send
        session_id: Session ID for multi-turn conversations
        display: If True, display messages beautifully as they arrive

    Note: BoxLite streams stdout in fixed-size chunks (not line-buffered),
    so we need to buffer data and parse complete JSON lines.
    """

    # Build message
    msg = {
        "type": "user",
        "message": {"role": "user", "content": content},
        "session_id": session_id,
        "parent_tool_use_id": None
    }

    # Send via stdin
    payload = json.dumps(msg) + "\n"
    logger.debug("send_message: Sending message (%d bytes)", len(payload))
    logger.debug("send_message: Content: %s...", content[:50])
    logger.debug("send_message: Session ID: %s", session_id)
    await stdin.send_input(payload.encode())
    logger.debug("send_message: Message sent to stdin, now reading stdout...")

    # Read response with buffering for chunked data
    responses = []
    new_session_id = session_id
    read_count = 0
    buffer = ""  # Accumulate data across chunks

    try:
        while True:
            read_count += 1
            logger.debug("send_message: Read attempt #%d, waiting for stdout.__anext__()...",
                         read_count)
            chunk = await asyncio.wait_for(stdout.__anext__(), timeout=120)

            if isinstance(chunk, bytes):
                chunk_str = chunk.decode('utf-8', errors='replace')
                logger.debug("send_message: Received bytes (%d bytes)", len(chunk))
            else:
                chunk_str = chunk
                logger.debug("send_message: Received str (%d chars)", len(chunk))

            # Add to buffer
            buffer += chunk_str
            logger.debug("send_message: Buffer size: %d chars", len(buffer))

            # Process complete lines (split by newline)
            while '\n' in buffer:
                line, buffer = buffer.split('\n', 1)
                line = line.strip()
                if not line:
                    continue

                logger.debug("send_message: Processing complete line (%d chars) the msg: %s",
                             len(line), line)

                try:
                    parsed_msg = json.loads(line)
                    responses.append(parsed_msg)
                    msg_type = parsed_msg.get("type", "unknown")
                    logger.debug("send_message: Parsed message type=%s", msg_type)

                    # Display message beautifully as it arrives
                    if display:
                        display_message(parsed_msg)

                    # Capture session_id for multi-turn
                    if parsed_msg.get("session_id"):
                        new_session_id = parsed_msg.get("session_id")
                        logger.debug("send_message: Updated session_id to: %s", new_session_id)

                    # Stop on result message
                    if msg_type == "result":
                        logger.debug("send_message: Got 'result' message, stopping read loop")
                        raise StopIteration
                except json.JSONDecodeError as e:
                    logger.debug("send_message: JSON parse error: %s", e)
                    logger.debug("send_message: Line preview: %s...", line[:100])

    except asyncio.TimeoutError:
        logger.debug("send_message: TIMEOUT after %d reads, responses collected: %d", read_count,
                     len(responses))
        if buffer:
            logger.debug("send_message: Remaining buffer: %d chars", len(buffer))
    except StopAsyncIteration:
        logger.debug("send_message: Stream ended (StopAsyncIteration) after %d reads", read_count)
    except StopIteration:
        logger.debug("send_message: Normal completion after %d reads", read_count)

    # Extract response from result message
    logger.debug("send_message: Total responses collected: %d", len(responses))
    for i, r in enumerate(responses):
        logger.debug("send_message: Response %d: type=%s", i, r.get('type', 'unknown'))

    # The 'result' message contains the final consolidated response
    result_msg = next((r for r in responses if r.get("type") == "result"), None)
    response_text = ""
    if result_msg:
        response_text = result_msg.get("result", "")
        logger.debug("send_message: Extracted result text (%d chars)", len(response_text))
    else:
        # Fallback: try to get text from assistant messages
        logger.debug("send_message: No result message, trying assistant messages...")
        for r in responses:
            if r.get("type") == "assistant":
                content_list = r.get("message", {}).get("content", [])
                for content in content_list:
                    if content.get("type") == "text" and content.get("text"):
                        response_text = content.get("text", "")
                        break
                if response_text:
                    break
        if response_text:
            logger.debug("send_message: Extracted assistant text (%d chars)", len(response_text))
        else:
            logger.debug("send_message: WARNING: No response text found!")

    return response_text, new_session_id


async def interactive_session(box):
    """Run an interactive multi-turn session with Claude."""

    print("\n=== Starting Claude Interactive Session ===")
    print("Type your messages. Type 'quit' to exit.\n")

    # Start Claude in stream-json mode
    logger.debug("interactive: Starting Claude CLI process...")
    proc = await box.exec(
        "claude",
        ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        [("CLAUDE_CODE_OAUTH_TOKEN", OAUTH_TOKEN)]
    )
    exec_id = proc.id()
    logger.debug("interactive: Process created, id=%s", exec_id)

    logger.debug("interactive: Getting stdin handle...")
    stdin = proc.stdin()
    logger.debug("interactive: stdin = %s", stdin)

    logger.debug("interactive: Getting stdout handle...")
    stdout = proc.stdout()
    logger.debug("interactive: stdout = %s", stdout)

    session_id = "default"
    logger.debug("interactive: Claude ready, entering input loop.")
    print()  # Blank line before user prompt

    # Keep reference for wait/close
    execution = proc

    def get_input():
        """Read input from stdin (runs in thread pool)."""
        sys.stdout.write("You: ")
        sys.stdout.flush()
        return sys.stdin.readline()

    try:
        loop = asyncio.get_event_loop()
        while True:
            # Get user input (run in thread pool to not block event loop)
            user_input = await loop.run_in_executor(None, get_input)

            # EOF check: readline() returns "" on EOF, "\n" on empty line
            if not user_input:
                print("\n[EOF detected, exiting]")
                break

            user_input = user_input.strip()
            if user_input.lower() in ('quit', 'exit', 'q'):
                break
            if not user_input:
                continue

            # Send message and get response (display=True shows messages as they arrive)
            print(f"\n{COLORS['bold']}Claude:{COLORS['reset']}")
            response, session_id = await send_message(stdin, stdout, user_input, session_id)
            print()  # Blank line after response

    except KeyboardInterrupt:
        print("\n\nInterrupted.")
    finally:
        # Signal EOF
        await stdin.close()
        result = await execution.wait()
        print(f"Session ended (exit code: {result.exit_code})")


async def demo_multi_turn(box):
    """Demonstrate multi-turn conversation."""

    print("\n=== Multi-turn Demo ===\n")

    # Start Claude
    execution = await box.exec(
        "claude",
        ["--dangerously-skip-permissions", "--input-format", "stream-json", "--output-format",
         "stream-json", "--verbose"],
        [("CLAUDE_CODE_OAUTH_TOKEN", OAUTH_TOKEN)]
    )
    stdin = execution.stdin()
    stdout = execution.stdout()

    # Turn 1
    print(f"{COLORS['bold']}Turn 1:{COLORS['reset']} Remember this number: 42")
    print(f"{COLORS['bold']}Claude:{COLORS['reset']}")
    response1, session_id = await send_message(stdin, stdout,
                                               "Remember this number: 42. Just say OK.")
    print()

    # Turn 2
    print(f"{COLORS['bold']}Turn 2:{COLORS['reset']} What number did I ask you to remember?")
    print(f"{COLORS['bold']}Claude:{COLORS['reset']}")
    response2, _ = await send_message(stdin, stdout, "What number did I ask you to remember?",
                                      session_id)
    print()

    # Verify
    success = "42" in response2
    if success:
        print(f"{COLORS['green']}✓ PASS{COLORS['reset']} - Claude remembered the number")
    else:
        print(f"{COLORS['red']}✗ FAIL{COLORS['reset']} - Claude did not remember the number")

    await stdin.close()
    await execution.wait()


async def main():
    if not OAUTH_TOKEN:
        print("ERROR: CLAUDE_CODE_OAUTH_TOKEN not set")
        print("Run: export CLAUDE_CODE_OAUTH_TOKEN='your-token'")
        sys.exit(1)

    runtime = boxlite.Boxlite.default()

    # Setup box with Claude
    box = await setup_claude_box(runtime)

    # Choose mode
    print("\nModes:")
    print("  1. Demo (automated multi-turn test)")
    print("  2. Interactive (chat with Claude)")

    sys.stdout.write("\nSelect mode [1/2]: ")
    sys.stdout.flush()
    loop = asyncio.get_event_loop()
    choice = await loop.run_in_executor(None, sys.stdin.readline)
    choice = choice.strip()

    if choice == "2":
        await interactive_session(box)
    else:
        await demo_multi_turn(box)

    print("\nDone! Box persists for future use.")


if __name__ == "__main__":
    setup_logging()
    asyncio.run(main())
