#!/usr/bin/env python3
"""
Run OpenAI Codex CLI inside a BoxLite box.

This is intentionally small and explicit:
1. create a Node.js box,
2. install @openai/codex with npm,
3. expose only a BoxLite secret placeholder as OPENAI_API_KEY inside the box,
4. run `codex exec` non-interactively.

Prerequisites:
    export OPENAI_API_KEY="sk-..."

Usage:
    python examples/python/06_ai_agents/run_codex_in_box.py \
      "Say exactly: codex inside box works"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import textwrap
import urllib.request
from pathlib import Path

import boxlite

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib  # type: ignore[no-redef]


DEFAULT_IMAGE = os.getenv("BOXLITE_CODEX_IMAGE", "ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3")
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
DEFAULT_PROFILE = os.getenv("BOXLITE_E2E_PROFILE") or os.getenv("BOXLITE_PROFILE") or "p1"
DEFAULT_DIRECT_KEY = os.getenv("BOXLITE_CODEX_SECRET_PASSTHROUGH", "").lower() not in ("1", "true", "yes", "on")
CODE_SMOKE_PROMPT = (
    "Create /workspace/fib.js. The file must read n from process.argv[2], compute fibonacci(n), "
    "and call console.log(String(result)) so stdout is exactly the number plus a newline. "
    "Run `node /workspace/fib.js 10`; if stdout is not exactly 55, fix the file and rerun it. "
    "Do not finish until `node /workspace/fib.js 10` prints exactly 55."
)


def print_openai_auth_help() -> None:
    print("ERROR: OPENAI_API_KEY not set")
    print("Run: export OPENAI_API_KEY='sk-...'")


def openai_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY")


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
    token = (
        os.getenv("BOXLITE_E2E_API_KEY")
        or profile.get("api_key")
        or os.getenv("BOXLITE_E2E_OIDC_TOKEN")
        or profile.get("access_token")
    )
    if not url or not token:
        print(f"ERROR: profile {profile_name!r} must include url and api_key/access_token")
        print("For API-key auth, the profile should look like:")
        print("")
        print(f"  [profiles.{profile_name}]")
        print('  url = "https://api.dev.boxlite.ai/api"')
        print('  api_key = "<boxlite-api-key>"')
        print('  auth_method = "api_key"')
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
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else str(chunk))
            if stream:
                print(f"[{label}] {chunks[-1]}", end="", flush=True)

    await asyncio.gather(
        collect(execution.stdout(), stdout_chunks, "stdout"),
        collect(execution.stderr(), stderr_chunks, "stderr"),
    )
    return "".join(stdout_chunks), "".join(stderr_chunks)


async def run(
    box,
    command: str,
    args: list[str],
    timeout: int = 300,
    *,
    stream: bool = False,
    env: list[tuple[str, str]] | None = None,
) -> tuple[int, str, str]:
    print(f"$ {command} {' '.join(args)}", flush=True)
    execution = await box.exec(command, args, env)
    stdout, stderr = await drain(execution, stream=stream)
    result = await asyncio.wait_for(execution.wait(), timeout=timeout)
    return result.exit_code, stdout, stderr


async def install_codex(box) -> None:
    print("Installing Codex CLI inside the box...", flush=True)
    exit_code, stdout, stderr = await run(
        box,
        "sh",
        [
            "-lc",
            "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex",
        ],
        timeout=600,
        stream=True,
    )
    if exit_code != 0:
        raise RuntimeError(f"failed to install Codex CLI\nstdout={stdout}\nstderr={stderr}")

    exit_code, stdout, stderr = await run(box, "codex", ["--version"], timeout=60)
    if exit_code != 0:
        raise RuntimeError(f"failed to verify Codex CLI\nstdout={stdout}\nstderr={stderr}")
    print(f"Codex CLI: {stdout.strip()}")


async def run_codex(box, prompt: str, model: str, *, direct_api_key: str | None = None) -> str:
    key_source = "direct env key" if direct_api_key else "BoxLite secret placeholder"
    print(f"Running Codex CLI with {key_source}...", flush=True)
    command = textwrap.dedent(
        f"""
        export OPENAI_API_KEY="${{OPENAI_API_KEY:-${{BOXLITE_SECRET_OPENAI_API_KEY:-<BOXLITE_SECRET:openai_api_key>}}}}"
        test -n "$OPENAI_API_KEY"
        export CODEX_HOME=/root/.codex-boxlite
        mkdir -p "$CODEX_HOME"
        printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null
        mkdir -p /workspace
        cd /workspace
        codex exec \
          --skip-git-repo-check \
          --ignore-user-config \
          --sandbox workspace-write \
          --model {model} \
          {prompt!r} \
          </dev/null
        """
    ).strip()
    env = [("OPENAI_API_KEY", direct_api_key)] if direct_api_key else None
    exit_code, stdout, stderr = await run(box, "sh", ["-lc", command], timeout=600, env=env)
    if exit_code != 0:
        raise RuntimeError(f"Codex CLI failed with exit code {exit_code}\nstdout={stdout}\nstderr={stderr}")
    return stdout.strip()


async def verify_code_smoke(box) -> None:
    print("Verifying Codex-created code inside the box...", flush=True)
    exit_code, stdout, stderr = await run(
        box,
        "sh",
        [
            "-lc",
            "set -eu\n"
            "test -f /workspace/fib.js\n"
            "node /workspace/fib.js 10\n",
        ],
        timeout=60,
        stream=True,
    )
    if exit_code != 0:
        raise RuntimeError(f"Codex code smoke verification failed\nstdout={stdout}\nstderr={stderr}")
    if stdout.strip() != "55":
        _, file_contents, _ = await run(
            box,
            "sh",
            ["-lc", "cat /workspace/fib.js"],
            timeout=30,
            stream=True,
        )
        raise RuntimeError(
            "Codex code smoke printed "
            f"{stdout.strip()!r}, expected '55'\n/workspace/fib.js:\n{file_contents}"
        )
    print("Verified: /workspace/fib.js prints 55", flush=True)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Install and run OpenAI Codex CLI inside a BoxLite box.")
    parser.add_argument("prompt", nargs="*", help="Prompt for codex exec")
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="Cloud REST profile from ~/.boxlite/credentials.toml")
    parser.add_argument(
        "--unsafe-direct-api-key",
        action="store_true",
        default=DEFAULT_DIRECT_KEY,
        help="Pass the plaintext OpenAI API key into the box to verify Codex CLI itself; this is the default until secret passthrough supports Codex.",
    )
    parser.add_argument(
        "--secret-passthrough",
        action="store_false",
        dest="unsafe_direct_api_key",
        help="Use the BoxLite secret placeholder instead of passing the plaintext key into the box.",
    )
    parser.add_argument(
        "--code-smoke",
        action="store_true",
        help="Ask Codex to create and run /workspace/fib.js, then verify the file by running node in the box.",
    )
    parser.add_argument("--keep-box", action="store_true", help="Keep the box after the run for inspection")
    args = parser.parse_args()

    api_key = openai_api_key()
    if not api_key:
        print_openai_auth_help()
        raise SystemExit(1)

    runtime = rest_runtime_from_profile(args.profile)
    if args.unsafe_direct_api_key:
        print("WARNING: using plaintext OPENAI_API_KEY inside the box for this smoke test.", flush=True)
        print("         Pass --secret-passthrough to test BoxLite secret substitution instead.", flush=True)
    box = await runtime.create(
        boxlite.BoxOptions(
            image=args.image,
            memory_mib=2048,
            disk_size_gb=8,
            auto_remove=not args.keep_box,
            network=boxlite.NetworkSpec(mode="enabled"),
            secrets=[
                boxlite.Secret(
                    name="openai_api_key",
                    value=api_key,
                    hosts=["api.openai.com"],
                )
            ],
        )
    )
    try:
        print(f"Box: {box.id}")
        await install_codex(box)
        prompt = CODE_SMOKE_PROMPT if args.code_smoke or not args.prompt else " ".join(args.prompt)
        answer = await run_codex(
            box,
            prompt,
            args.model,
            direct_api_key=api_key if args.unsafe_direct_api_key else None,
        )
        print(answer)
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
