"""Run domain actions through the checkout's public SDKs and CLI."""

import asyncio
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from e2e_auth import auth_context

ROOT = Path(__file__).resolve().parents[3]
DRIVERS = ROOT / "apps/e2e/sdks"
CLIENTS = ("python-async", "python-sync", "node", "go", "c", "rust", "cli")


class ClientEnvironment(dict):
    def __repr__(self):
        return "<domain client environment redacted>"


class DomainClient:
    def __init__(self, name, home):
        self.name = name
        ctx = auth_context()
        self.env = ClientEnvironment(
            {
                **os.environ,
                **ctx.api_key_sdk_env(),
                "BOXLITE_HOME": str(home),
                "RUST_LOG": "error",
                "BOXLITE_REST_URL": ctx.url,
                "BOXLITE_API_KEY": ctx.token,
                "BOXLITE_REST_PATH_PREFIX": ctx.path_prefix,
            }
        )
        for key in ("BOXLITE_PROFILE", "BOXLITE_CONTEXT"):
            self.env.pop(key, None)
        commands = {
            "python-async": [
                sys.executable,
                str(DRIVERS / "python/e2e_domains.py"),
                "async",
            ],
            "python-sync": [
                sys.executable,
                str(DRIVERS / "python/e2e_domains.py"),
                "sync",
            ],
            "node": ["node", str(DRIVERS / "node/e2e_domains.mjs")],
            "go": [str(ROOT / "target/e2e/domain-go")],
            "c": [str(ROOT / "target/e2e/domain-c")],
            "rust": [str(ROOT / "target/debug/examples/e2e_domains")],
            "cli": [
                os.environ.get("BOXLITE_E2E_CLI")
                or shutil.which("boxlite")
                or str(ROOT / "target/debug/boxlite")
            ],
        }
        self.command = commands[name]
        if not shutil.which(self.command[0]):
            raise RuntimeError(
                f"{name} client missing; build the SDKs and make build:e2e:drivers"
            )
        if name == "node" and not any((ROOT / "sdks/node/native").glob("*.node")):
            raise RuntimeError("Node native SDK missing; run make dev:node")

    async def call(self, action, *args, box_id="", error=None):
        argv = [*self.command, action, *map(str, args)]
        if self.name == "cli":
            tail = (
                ["--format", "json"]
                if action == "list"
                else [args[0], "--box", box_id, "--port", str(args[1])]
                if action == "bind"
                else list(args)
            )
            argv = [
                *self.command,
                "domain",
                "ls" if action == "list" else action,
                *tail,
            ]
        result = await asyncio.to_thread(
            subprocess.run,
            argv,
            env=ClientEnvironment({**self.env, "BOXLITE_E2E_BOX": box_id}),
            capture_output=True,
            text=True,
            timeout=45,
            cwd=ROOT,
        )
        stdout = result.stdout.replace(self.env["BOXLITE_API_KEY"], "[redacted]")
        stderr = result.stderr.replace(self.env["BOXLITE_API_KEY"], "[redacted]")
        if error:
            assert result.returncode > 0, (
                f"{self.name} {action} did not reject invalid input"
            )
            assert error in stderr, (
                f"{self.name} failed for a different reason: {stderr}"
            )
            return None
        assert result.returncode == 0, (
            f"{self.name} {action} exit {result.returncode}: {stderr}"
        )
        if self.name == "cli" and action != "list":
            return stdout
        data = json.loads(stdout)
        if self.name == "cli":
            assert all("Name" not in d and "name" not in d for d in data)
            return {
                "domains": [
                    {
                        "hostname": d["Hostname"],
                        "url": d["URL"],
                        "target": None if d["Target"] == "-" else d["Target"],
                    }
                    for d in data
                ]
            }
        return data
