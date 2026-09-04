#!/usr/bin/env python3
"""Launch the tiny code agent inside a cloud REST-backed BoxLite box."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
import urllib.request
from pathlib import Path

import boxlite

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib  # type: ignore[no-redef]


DEFAULT_IMAGE = os.getenv("BOXLITE_CODE_AGENT_IMAGE", "ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3")
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
DEFAULT_PROFILE = os.getenv("BOXLITE_E2E_PROFILE") or os.getenv("BOXLITE_PROFILE") or "p1"
CODE_SMOKE_GOAL = (
    "Create /workspace/fib.py. It must read n from sys.argv[1], compute fibonacci(n), "
    "print only the number, then run `python /workspace/fib.py 10` and make sure it prints 55."
)


def prompt_openai_api_key() -> str | None:
    value = os.getenv("OPENAI_API_KEY")
    if value:
        return value
    if not sys.stdin.isatty():
        return None
    value = getpass.getpass("OPENAI_API_KEY: ").strip()
    return value or None


def credentials_path() -> Path:
    if os.getenv("BOXLITE_HOME"):
        return Path(os.environ["BOXLITE_HOME"]) / "credentials.toml"
    return Path.home() / ".boxlite" / "credentials.toml"


def discover_path_prefix(url: str, token: str) -> str:
    request = urllib.request.Request(
        f"{url.rstrip('/')}/v1/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        body = json.loads(response.read() or "null")
    return (body or {}).get("path_prefix") or ""


def rest_runtime_from_profile(profile_name: str):
    path = credentials_path()
    if not path.exists():
        print(f"ERROR: {path} is missing")
        print("Create a cloud REST profile first, for example:")
        print("")
        print("  mkdir -p ~/.boxlite")
        print("  cat > ~/.boxlite/credentials.toml <<'EOF'")
        print("  [profiles.p1]")
        print('  url = "https://api.dev.boxlite.ai/api"')
        print('  api_key = "<boxlite-api-key>"')
        print('  auth_method = "api_key"')
        print("  EOF")
        raise SystemExit(1)

    data = tomllib.loads(path.read_text(encoding="utf-8"))
    profile = data.get("profiles", {}).get(profile_name)
    if not profile:
        print(f"ERROR: profile {profile_name!r} not found in {path}")
        print(f"Run: export BOXLITE_PROFILE='{profile_name}'")
        print(f"Or pass: --profile {profile_name}")
        raise SystemExit(1)

    url = os.getenv("BOXLITE_E2E_API_URL") or profile.get("url")
    token = os.getenv("BOXLITE_E2E_API_KEY") or profile.get("api_key") or os.getenv("BOXLITE_E2E_OIDC_TOKEN") or profile.get("access_token")
    if not url or not token:
        print(f"ERROR: profile {profile_name!r} must include url and api_key/access_token")
        raise SystemExit(1)

    explicit_prefix = os.getenv("BOXLITE_E2E_PREFIX")
    if explicit_prefix is not None:
        path_prefix = explicit_prefix
    elif os.getenv("BOXLITE_E2E_DISCOVER_PREFIX", "1") != "0":
        path_prefix = discover_path_prefix(url, token)
    else:
        path_prefix = profile.get("path_prefix") or ""

    print(f"Runtime: REST profile={profile_name} url={url} prefix={path_prefix or '<none>'}", flush=True)
    return boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=url,
            credential=boxlite.ApiKeyCredential(token),
            path_prefix=path_prefix,
        )
    )


async def drain(execution, *, stream: bool = False) -> tuple[str, str]:
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    async def collect(source, chunks: list[str], label: str) -> None:
        async for chunk in source:
            text = chunk.decode() if isinstance(chunk, bytes) else str(chunk)
            chunks.append(text)
            if stream:
                print(f"[{label}] {text}", end="", flush=True)

    await asyncio.gather(
        collect(execution.stdout(), stdout_chunks, "stdout"),
        collect(execution.stderr(), stderr_chunks, "stderr"),
    )
    return "".join(stdout_chunks), "".join(stderr_chunks)


async def run(box, command: str, args: list[str], *, env: list[tuple[str, str]] | None = None, timeout: int = 300, stream: bool = False) -> tuple[int, str, str]:
    print(f"$ {command} {' '.join(args)}", flush=True)
    execution = await box.exec(command, args, env)
    stdout, stderr = await drain(execution, stream=stream)
    result = await asyncio.wait_for(execution.wait(), timeout=timeout)
    return result.exit_code, stdout, stderr


async def verify_code_smoke(box) -> None:
    print("Verifying agent-created code inside the box...", flush=True)
    exit_code, stdout, stderr = await run(
        box,
        "sh",
        ["-lc", "set -eu\ntest -f /workspace/fib.py\npython /workspace/fib.py 10\n"],
        timeout=60,
        stream=True,
    )
    if exit_code != 0:
        raise RuntimeError(f"code-agent verification failed\nstdout={stdout}\nstderr={stderr}")
    if stdout.strip() != "55":
        raise RuntimeError(f"code-agent printed {stdout.strip()!r}, expected '55'")
    print("Verified: /workspace/fib.py prints 55", flush=True)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run a tiny OpenAI-powered code agent inside a BoxLite box.")
    parser.add_argument("goal", nargs="*", help="Goal for the code agent")
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--code-smoke", action="store_true")
    parser.add_argument("--keep-box", action="store_true")
    args = parser.parse_args()

    api_key = prompt_openai_api_key()
    if not api_key:
        print("ERROR: OPENAI_API_KEY not set")
        print("Run: export OPENAI_API_KEY='sk-...'")
        raise SystemExit(1)

    runtime = rest_runtime_from_profile(args.profile)
    box = await runtime.create(
        boxlite.BoxOptions(
            image=args.image,
            memory_mib=1024,
            disk_size_gb=4,
            auto_remove=not args.keep_box,
            network=boxlite.NetworkSpec(mode="enabled", allow_net=["api.openai.com"]),
        )
    )
    try:
        print(f"Box: {box.id}", flush=True)
        agent_path = Path(__file__).with_name("code_agent.py")
        await box.copy_in(str(agent_path), "/workspace/code_agent.py")
        goal = CODE_SMOKE_GOAL if args.code_smoke or not args.goal else " ".join(args.goal)
        exit_code, stdout, stderr = await run(
            box,
            "python",
            ["/workspace/code_agent.py", goal, "--model", args.model],
            env=[("OPENAI_API_KEY", api_key)],
            timeout=600,
            stream=True,
        )
        if exit_code != 0:
            raise RuntimeError(f"code-agent failed with exit code {exit_code}\nstdout={stdout}\nstderr={stderr}")
        if args.code_smoke:
            await verify_code_smoke(box)
        return 0
    finally:
        if not args.keep_box:
            try:
                await runtime.remove(box.id, force=True)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
