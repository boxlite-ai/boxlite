#!/usr/bin/env python3
"""
Interactive terminal for installing Claude Code.

This example opens an interactive /bin/bash shell inside a container (default image:
debian:bookworm-slim) so you can install Claude Code directly in that terminal.

Usage:
    python examples/python/interactive_claude_example.py

Optional env:
    CLAUDE_CODE_OAUTH_TOKEN  OAuth token for Claude Code (forwarded into the box)
    BOXLITE_CLAUDE_IMAGE     Container image to use (default: debian:bookworm-slim)
    BOXLITE_CLAUDE_BOX_NAME  Box name to persist and reuse (default: claude-box)
    BOXLITE_CLAUDE_BOX_ID    Existing box ID to reattach to instead of creating/selecting by name
"""

import asyncio
import logging
import os
import sys
import termios
import tty

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from _helpers import setup_logging
except ImportError:
    def setup_logging():
        logging.basicConfig(level=logging.ERROR)

logger = logging.getLogger("interactive_claude_example")

BOX_NAME = os.environ.get("BOXLITE_CLAUDE_BOX_NAME", "claude-box")
BOX_ID = os.environ.get("BOXLITE_CLAUDE_BOX_ID", "")
IMAGE = os.environ.get("BOXLITE_CLAUDE_IMAGE", "debian:bookworm-slim")
OAUTH_TOKEN = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")


def print_install_instructions():
    print("Inside the box, run:")
    print("  apt-get update")
    print("  apt-get install -y curl ca-certificates gnupg")
    print("  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -")
    print("  apt-get install -y nodejs")
    print("  npm install -g @anthropic-ai/claude-code")
    print("  claude --version")
    print("  claude")


async def run_interactive_shell(box, env, shell="/bin/bash"):
    """Run an interactive shell using native Box.exec with PTY."""
    try:
        execution = await box.exec(shell, [], env, True)
    except TypeError:
        # Fallback for older SDKs without tty parameter
        execution = await box.exec(shell, [], env)
    stdin = execution.stdin()
    stdout = execution.stdout()
    stderr = execution.stderr()

    if not sys.stdin.isatty():
        await execution.wait()
        return

    old_tty_settings = termios.tcgetattr(sys.stdin.fileno())
    tty.setraw(sys.stdin.fileno(), when=termios.TCSANOW)
    exited = asyncio.Event()

    async def forward_stdin():
        try:
            loop = asyncio.get_event_loop()
            while not exited.is_set():
                try:
                    read_task = loop.run_in_executor(
                        None, os.read, sys.stdin.fileno(), 1024
                    )
                    done, pending = await asyncio.wait(
                        [
                            asyncio.ensure_future(read_task),
                            asyncio.ensure_future(exited.wait()),
                        ],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    if exited.is_set():
                        break
                    for task in done:
                        if task.exception() is None:
                            data = task.result()
                            if isinstance(data, bytes) and data:
                                await stdin.send_input(data)
                            elif not data:
                                return
                except asyncio.CancelledError:
                    break
        except Exception as e:
            logger.error(f"Caught exception on stdin: {e}")

    async def forward_output(stream, target):
        try:
            async for chunk in stream:
                if isinstance(chunk, bytes):
                    target.buffer.write(chunk)
                else:
                    target.buffer.write(chunk.encode("utf-8", errors="replace"))
                target.buffer.flush()
        except asyncio.CancelledError:
            # Task was cancelled as part of normal shutdown; no action needed.
            pass
        except Exception as e:
            logger.error(f"Error forwarding output: {e}")

    async def wait_for_exit():
        try:
            await execution.wait()
        finally:
            exited.set()

    try:
        await asyncio.gather(
            forward_stdin(),
            forward_output(stdout, sys.stdout),
            forward_output(stderr, sys.stderr),
            wait_for_exit(),
            return_exceptions=True,
        )
    finally:
        termios.tcsetattr(
            sys.stdin.fileno(), termios.TCSADRAIN, old_tty_settings
        )


async def main():
    print("Starting interactive container...")
    print("Type 'exit' or press Ctrl+D to quit.\n")
    print("This example keeps the box so installs persist.")
    print(f"Box name: {BOX_NAME}\n")
    print_install_instructions()
    print()

    try:
        from boxlite import Boxlite, InteractiveBox

        term_mode = os.environ.get("TERM", "xterm-256color")
        env = [("TERM", term_mode)]
        if OAUTH_TOKEN:
            env.append(("CLAUDE_CODE_OAUTH_TOKEN", OAUTH_TOKEN))
        else:
            print("Note: CLAUDE_CODE_OAUTH_TOKEN not set on host.")
            print("You can export it inside the box before running `claude`.\n")

        runtime = Boxlite.default()

        if BOX_ID:
            # Reattach to existing box by ID
            # Note: env variables are only used for this shell session, not applied to box config
            box = await runtime.get(BOX_ID)
            if box is None:
                raise RuntimeError(f"Box not found: {BOX_ID}")
            print(f"Reattached to box id: {BOX_ID}")
            await run_interactive_shell(box, env, shell="/bin/bash")
            await box.stop()
            print("Box stopped (data persisted). Re-run to continue.")
            return

        existing = await runtime.get(BOX_NAME)
        if existing is not None:
            # Found existing box by name
            # Note: env variables are only used for this shell session, not applied to box config
            print("Found existing box with same name.")
            print(f"Set BOXLITE_CLAUDE_BOX_ID={existing.id} to reattach.")
            print("Or remove it and re-run to create a new one.")
            await run_interactive_shell(existing, env, shell="/bin/bash")
            await existing.stop()
            print("Box stopped (data persisted). Re-run to continue.")
            return

        # Create new box with specified configuration
        async with InteractiveBox(
            image=IMAGE,
            shell="/bin/bash",
            name=BOX_NAME,
            auto_remove=False,
            env=env,
            memory_mib=2048,
            disk_size_gb=8,
        ) as itbox:
            print(f"Box id: {itbox.id}")
            print(f"Tip: export BOXLITE_CLAUDE_BOX_ID={itbox.id} to reattach next time.")
            await itbox.wait()

    except KeyboardInterrupt:
        print("\n\nInterrupted by Ctrl+C")
    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    setup_logging()
    asyncio.run(main())
