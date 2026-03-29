#!/usr/bin/env python3
"""
Simple Interactive Shell - Drop directly into a container shell

This is the simplest example - just like running `docker exec -it container sh`.
Run this script and you'll get an interactive shell where you can type commands.

Usage:
    python examples/python/interactivebox_example.py
"""

import asyncio
import logging
import os
import sys

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from _helpers import setup_logging
except ImportError:
    def setup_logging():
        logging.basicConfig(level=logging.ERROR)

logger = logging.getLogger("interactivebox_example")


async def main():
    print("Starting interactive Alpine container...")
    print("Type 'exit' or press Ctrl+D to quit\n")

    try:
        from boxlite import InteractiveBox

        from boxlite import Secret

        # This is all you need for an interactive shell!
        term_mode = os.environ.get("TERM", "xterm-256color")
        print(f"Terminal mode: {term_mode}")

        # Test secret substitution: the guest sees the placeholder,
        # the MITM proxy substitutes the real value on HTTPS requests.
        #
        # To test: run test_secret_server.py in another terminal first,
        # then use wget inside the shell to hit it via the secret host.
        # Test against a real public HTTPS endpoint.
        # The MITM proxy intercepts the TLS connection, substitutes the
        # placeholder with the real value, and forwards to the real server.
        secrets = [
            Secret(
                name="openai",
                value="sk-REAL-SECRET-VALUE-12345",
                hosts=["api.openai.com"],
            ),
        ]
        print(f"Secrets configured: {secrets}")
        print()
        print("  Test commands (inside the shell):")
        print("    # 1. Verify placeholder env var (not real key):")
        print("    echo $BOXLITE_SECRET_OPENAI")
        print()
        print("    # 2. Test MITM substitution against real API:")
        print("    wget -qO- \\")
        print("      --header='Authorization: Bearer <BOXLITE_SECRET:openai>' \\")
        print("      https://api.openai.com/v1/models 2>&1 | head -5")
        print()
        print("    # If MITM works: get 401 (invalid key) — NOT a TLS error")
        print("    # If MITM fails: get SSL/TLS connection error")
        print()

        async with InteractiveBox(
            image="alpine:latest",
            env=[
                ("TERM", term_mode),
            ],
            ports=[(28080, 8000)],
            allow_net=["api.openai.com"],
            secrets=secrets,
        ) as itbox:
            # You're now in an interactive shell
            # Everything you type goes to the container
            # Everything the container outputs comes back to your terminal

            # Wait for the shell to exit
            # The InteractiveBox automatically handles all I/O in background tasks
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
