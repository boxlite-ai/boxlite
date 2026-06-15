"""Preflight checks — run before any runtime mutation.

Each check returns a human-readable failure string (or None / []); `doctor()`
aggregates them into a flat list and, when strict, raises `DoctorError`. No
result-type ceremony — the messages are the API.

macOS-only: the port check relies on `lsof`.
"""

from __future__ import annotations

import shutil
import subprocess

from ._sdk import import_sdk
from .config import InfraConfig
from .services import ServiceSpec


class DoctorError(RuntimeError):
    """Raised when doctor(strict=True) finds any failing check."""


def _lsof_owner(port: int) -> str | None:
    """Command name holding a TCP LISTEN on `port`, or None if free.

    `lsof` exits 1 when nothing is listening — the happy path. Raises
    DoctorError if lsof itself errors (so we never silently report "free").
    """
    if not shutil.which("lsof"):
        raise DoctorError("lsof not found; cannot verify port availability")
    proc = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-F", "c"],
        capture_output=True,
        text=True,
        check=False,
    )
    # -F c output is one field per line; the command is the `c`-prefixed line.
    for line in proc.stdout.splitlines():
        if line.startswith("c"):
            return line[1:]
    if proc.returncode != 0 and proc.stderr.strip():
        raise DoctorError(f"lsof exited {proc.returncode}: {proc.stderr.strip()[:120]}")
    return None


def check_ports_free(ports: list[int]) -> list[str]:
    """One failure string per port held by a non-boxlite listener."""
    failures: list[str] = []
    for port in ports:
        try:
            owner = _lsof_owner(port)
        except DoctorError as e:
            failures.append(str(e))
            continue
        # A boxlite-owned listener (boxlite-serve / boxlited / boxlite-shim) is
        # one of ours, not a conflict.
        if owner and not owner.startswith("boxlite"):
            failures.append(f"port {port} held by `{owner}` — stop it or change the port")
    return failures


def check_sdk() -> str | None:
    try:
        import_sdk()
        return None
    except ImportError as e:
        return (
            f"BoxLite SDK not importable: {e} — run "
            "`pip install -e sdks/python` and confirm `which python`"
        )


async def check_runtime() -> str | None:
    try:
        Boxlite, _ = import_sdk()
        await Boxlite.default().list_info()
        return None
    except Exception as e:
        return f"BoxLite runtime not responding ({type(e).__name__}: {e}) — check `boxlite serve` / lockfile"


async def doctor(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    strict: bool = True,
) -> list[str]:
    """Run preflight checks; return failure strings (empty == healthy).

    Raises DoctorError if `strict` and any check fails.
    """
    failures: list[str] = []
    sdk_err = check_sdk()
    if sdk_err:
        failures.append(sdk_err)
    else:
        runtime_err = await check_runtime()
        if runtime_err:
            failures.append(runtime_err)
    ports = [host_port for spec in services.values() for host_port, _ in spec.ports]
    failures += check_ports_free(ports)
    if strict and failures:
        raise DoctorError("; ".join(failures))
    return failures
