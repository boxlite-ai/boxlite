#!/usr/bin/env python3
"""
Load REST connection config from environment variables.

Demonstrates:
- BoxliteRestOptions.from_env() for environment-based configuration
- API-key authentication via BOXLITE_API_KEY
- Useful for CI/CD pipelines and production deployments

Environment variables:
    BOXLITE_REST_URL          Server URL (required)
    BOXLITE_API_KEY           Long-lived API key
    BOXLITE_REST_PREFIX       API version prefix (default: v1)

Usage:
    BOXLITE_REST_URL=http://localhost:8100 \
    BOXLITE_API_KEY=your-api-key \
    python use_env_config.py

Prerequisites:
    make dev:python
    boxlite serve --port 8100
"""

import asyncio

from boxlite import Boxlite, BoxliteRestOptions


async def main():
    print("=" * 50)
    print("REST API: Environment-Based Configuration")
    print("=" * 50)

    # Load connection config from environment variables. from_env() reads
    # BOXLITE_REST_URL (required) and BOXLITE_API_KEY (wrapped in an
    # ApiKeyCredential automatically when set).
    try:
        opts = BoxliteRestOptions.from_env()
    except Exception as e:
        print(f"\n  Error: {e}")
        print("  Set BOXLITE_REST_URL and BOXLITE_API_KEY:")
        print("    BOXLITE_REST_URL=http://localhost:8100 \\")
        print("    BOXLITE_API_KEY=your-api-key \\")
        print("    python use_env_config.py")
        return

    print(f"\n  Loaded config: {opts}")

    rt = Boxlite.rest(opts)

    # Quick smoke test: list boxes
    boxes = await rt.list_info()
    print(f"  Boxes on server: {len(boxes)}")

    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
