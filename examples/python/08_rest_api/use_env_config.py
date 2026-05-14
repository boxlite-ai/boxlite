#!/usr/bin/env python3
"""
Load REST connection config from environment variables.

Demonstrates:
- BoxliteRestOptions.from_env() for environment-based configuration
- Two credential styles: OAuth2 client pair, or long-lived API key
- Useful for CI/CD pipelines and production deployments

Environment variables:
    BOXLITE_REST_URL          Server URL (required)
    BOXLITE_API_KEY           Long-lived API key (recommended)
    BOXLITE_REST_CLIENT_ID    OAuth2 client ID (alternative)
    BOXLITE_REST_CLIENT_SECRET OAuth2 client secret (alternative)
    BOXLITE_REST_PREFIX       API version prefix (default: v1)

Usage (API key path, recommended):
    BOXLITE_REST_URL=http://localhost:8080 \
    BOXLITE_API_KEY=your-api-key \
    python use_env_config.py

Usage (OAuth2 client credentials, machine-to-machine):
    BOXLITE_REST_URL=http://localhost:8080 \
    BOXLITE_REST_CLIENT_ID=test-client \
    BOXLITE_REST_CLIENT_SECRET=test-secret \
    python use_env_config.py

Prerequisites:
    make dev:python
    cd openapi/reference-server && uv run --active server.py --port 8080
"""

import asyncio

from boxlite import Boxlite, BoxliteRestOptions


async def main():
    print("=" * 50)
    print("REST API: Environment-Based Configuration")
    print("=" * 50)

    # Load connection config from environment variables. from_env() accepts
    # either BOXLITE_API_KEY (recommended) or the BOXLITE_REST_CLIENT_ID /
    # BOXLITE_REST_CLIENT_SECRET pair (machine-to-machine).
    try:
        opts = BoxliteRestOptions.from_env()
    except Exception as e:
        print(f"\n  Error: {e}")
        print("  Set BOXLITE_REST_URL plus one credential style.")
        print("  API key (recommended):")
        print("    BOXLITE_REST_URL=http://localhost:8080 \\")
        print("    BOXLITE_API_KEY=your-api-key \\")
        print("    python use_env_config.py")
        print("  OAuth2 client credentials:")
        print("    BOXLITE_REST_URL=http://localhost:8080 \\")
        print("    BOXLITE_REST_CLIENT_ID=test-client \\")
        print("    BOXLITE_REST_CLIENT_SECRET=test-secret \\")
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
