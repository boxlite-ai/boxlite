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

Or put OPENAI_API_KEY / BOXLITE_E2E_OPENAI_API_KEY in:
    ~/.config/boxlite/e2e-openai.env

Usage:
    python examples/python/06_ai_agents/run_codex_in_box.py \
      "Say exactly: codex inside box works"
"""

from __future__ import annotations

import argparse
import asyncio
import os
import textwrap
from pathlib import Path

import boxlite


DEFAULT_IMAGE = os.getenv("BOXLITE_CODEX_IMAGE", "node:20-bookworm-slim")
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
DEFAULT_ENV_FILE = Path(os.getenv("BOXLITE_OPENAI_ENV_FILE", "~/.config/boxlite/e2e-openai.env")).expanduser()


def load_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            values[key] = value
    return values


def openai_api_key(env_file: Path) -> str | None:
    if os.getenv("OPENAI_API_KEY"):
        return os.getenv("OPENAI_API_KEY")

    values = load_env_file(env_file)
    return values.get("OPENAI_API_KEY") or values.get("BOXLITE_E2E_OPENAI_API_KEY")


async def drain(execution) -> tuple[str, str]:
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    async def collect(stream, chunks: list[str]) -> None:
        async for chunk in stream:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else str(chunk))

    await asyncio.gather(
        collect(execution.stdout(), stdout_chunks),
        collect(execution.stderr(), stderr_chunks),
    )
    return "".join(stdout_chunks), "".join(stderr_chunks)


async def run(box, command: str, args: list[str], timeout: int = 300) -> tuple[int, str, str]:
    execution = await box.exec(command, args, None)
    stdout, stderr = await drain(execution)
    result = await asyncio.wait_for(execution.wait(), timeout=timeout)
    return result.exit_code, stdout, stderr


async def install_codex(box) -> None:
    exit_code, stdout, stderr = await run(
        box,
        "sh",
        [
            "-lc",
            "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex",
        ],
        timeout=600,
    )
    if exit_code != 0:
        raise RuntimeError(f"failed to install Codex CLI\nstdout={stdout}\nstderr={stderr}")

    exit_code, stdout, stderr = await run(box, "codex", ["--version"], timeout=60)
    if exit_code != 0:
        raise RuntimeError(f"failed to verify Codex CLI\nstdout={stdout}\nstderr={stderr}")
    print(f"Codex CLI: {stdout.strip()}")


async def run_codex(box, prompt: str, model: str) -> str:
    command = textwrap.dedent(
        f"""
        export OPENAI_API_KEY="$BOXLITE_SECRET_OPENAI_API_KEY"
        export CODEX_HOME=/root/.codex-boxlite
        mkdir -p "$CODEX_HOME"
        printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null
        mkdir -p /workspace
        cd /workspace
        codex exec \
          --skip-git-repo-check \
          --ignore-user-config \
          --sandbox read-only \
          --model {model} \
          {prompt!r} \
          </dev/null
        """
    ).strip()
    exit_code, stdout, stderr = await run(box, "sh", ["-lc", command], timeout=600)
    if exit_code != 0:
        raise RuntimeError(f"Codex CLI failed with exit code {exit_code}\nstdout={stdout}\nstderr={stderr}")
    return stdout.strip()


async def main() -> int:
    parser = argparse.ArgumentParser(description="Install and run OpenAI Codex CLI inside a BoxLite box.")
    parser.add_argument("prompt", nargs="+", help="Prompt for codex exec")
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--keep-box", action="store_true", help="Keep the box after the run for inspection")
    args = parser.parse_args()

    api_key = openai_api_key(args.env_file.expanduser())
    if not api_key:
        raise SystemExit(f"OPENAI_API_KEY is required on the host or in {args.env_file}")

    runtime = boxlite.Boxlite.default()
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
        answer = await run_codex(box, " ".join(args.prompt), args.model)
        print(answer)
        return 0
    finally:
        if not args.keep_box:
            try:
                await runtime.remove(box.id, force=True)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
