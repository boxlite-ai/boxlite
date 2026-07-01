#!/usr/bin/env python3
"""Tiny code-writing agent that runs inside a BoxLite box."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any
import urllib.error
import urllib.request


DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
WORKSPACE = Path(os.getenv("CODE_AGENT_WORKSPACE", "/workspace")).resolve()


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write UTF-8 text to a file under /workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read UTF-8 text from a file under /workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a shell command from /workspace and return stdout, stderr, and exit code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    },
]


def api_key() -> str:
    value = os.getenv("OPENAI_API_KEY")
    if not value:
        raise SystemExit("OPENAI_API_KEY is required inside the box")
    return value


def workspace_path(path: str) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = WORKSPACE / candidate
    resolved = candidate.resolve()
    if resolved != WORKSPACE and WORKSPACE not in resolved.parents:
        raise ValueError(f"path must stay under {WORKSPACE}: {path}")
    return resolved


def call_openai(messages: list[dict[str, Any]], model: str, timeout: int) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0,
    }
    request = urllib.request.Request(
        f"{OPENAI_BASE_URL.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
            "User-Agent": "boxlite-code-agent/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"OpenAI request failed with HTTP {exc.code}: {body[:1000]}") from exc


def run_tool(name: str, args: dict[str, Any], timeout: int) -> str:
    if name == "write_file":
        target = workspace_path(args["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(args["content"], encoding="utf-8")
        return json.dumps({"ok": True, "path": str(target)})

    if name == "read_file":
        target = workspace_path(args["path"])
        return json.dumps({"path": str(target), "content": target.read_text(encoding="utf-8")})

    if name == "run_command":
        result = subprocess.run(
            args["command"],
            cwd=str(WORKSPACE),
            shell=True,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return json.dumps(
            {
                "exit_code": result.returncode,
                "stdout": result.stdout[-4000:],
                "stderr": result.stderr[-4000:],
            }
        )

    raise ValueError(f"unknown tool: {name}")


def run_agent(goal: str, model: str, max_steps: int, timeout: int) -> str:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "You are a code agent running inside /workspace. Use tools to write files "
                "and run commands. Finish with a concise summary and include the final command output."
            ),
        },
        {"role": "user", "content": goal},
    ]

    for step in range(1, max_steps + 1):
        data = call_openai(messages, model, timeout)
        message = data["choices"][0]["message"]
        messages.append(message)
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            return message.get("content") or ""

        for call in tool_calls:
            name = call["function"]["name"]
            args = json.loads(call["function"].get("arguments") or "{}")
            print(f"[step {step}] tool={name} args={json.dumps(args, ensure_ascii=False)}", flush=True)
            output = run_tool(name, args, timeout)
            print(f"[step {step}] output={output}", flush=True)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": output,
                }
            )

    raise RuntimeError(f"agent did not finish within {max_steps} steps")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a tiny code agent inside a BoxLite box.")
    parser.add_argument("goal", nargs="+")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--max-steps", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    final = run_agent(" ".join(args.goal), args.model, args.max_steps, args.timeout)
    print("\nFinal answer:")
    print(final)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
