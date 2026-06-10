"""Preflight checks — run before any runtime mutation.

Checks (walking skeleton, postgres-only):
  1. BoxLite SDK importable
  2. BoxLite runtime reachable (list_info succeeds)
  3. For each (host_port, _) in services[*].ports: lsof shows no non-boxlite listener

Each check returns a DoctorCheck. doctor() aggregates them into a DoctorReport.
If strict=True and any check is Severity.FAIL, raises DoctorError.

macOS-only: relies on `lsof` and BSD-style flags. Cross-platform support is
out of scope for the walking skeleton.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

from .config import InfraConfig
from .types import DoctorCheck, DoctorError, DoctorReport, ServiceSpec, Severity


@dataclass(frozen=True)
class _LsofRow:
    pid: int
    cmd: str
    user: str
    name: str


def _parse_lsof_F(output: str) -> list[_LsofRow]:
    """Parse `lsof -F pcLn` machine-readable output into rows.

    Format: one field per line, prefix byte indicates field type.
      p<pid>   c<command>   L<login>   n<name>
    Process records are introduced by `p`. Subsequent fields belong to
    that process until the next `p`.
    """
    rows: list[_LsofRow] = []
    pid: int | None = None
    cmd = user = name = ""
    for line in output.splitlines():
        if not line:
            continue
        prefix, value = line[0], line[1:]
        if prefix == "p":
            if pid is not None:
                rows.append(_LsofRow(pid=pid, cmd=cmd, user=user, name=name))
            pid = int(value)
            cmd = user = name = ""
        elif prefix == "c":
            cmd = value
        elif prefix == "L":
            user = value
        elif prefix == "n":
            name = value
    if pid is not None:
        rows.append(_LsofRow(pid=pid, cmd=cmd, user=user, name=name))
    return rows


def _is_boxlite_owner(cmd: str) -> bool:
    """True iff the lsof command name is one of ours (boxlite-serve, boxlited, boxlite-s truncation, ...)."""
    return cmd.startswith("boxlite")


def check_sdk_importable() -> DoctorCheck:
    try:
        try:
            from boxlite import Boxlite  # noqa: F401
        except ImportError:
            from boxlite.boxlite import Boxlite  # noqa: F401
        return DoctorCheck(
            name="sdk-importable",
            severity=Severity.OK,
            msg="BoxLite SDK importable",
        )
    except ImportError as e:
        return DoctorCheck(
            name="sdk-importable",
            severity=Severity.FAIL,
            msg=f"BoxLite Python SDK not importable: {e}",
            hint="Run `pip install -e sdks/python` from the boxlite repo, and confirm `which python` points at the right interpreter.",
        )


async def check_runtime_reachable() -> DoctorCheck:
    try:
        try:
            from boxlite import Boxlite
        except ImportError:
            from boxlite.boxlite import Boxlite
        runtime = Boxlite.default()
        await runtime.list_info()
        return DoctorCheck(
            name="runtime-reachable",
            severity=Severity.OK,
            msg="BoxLite runtime reachable",
        )
    except Exception as e:
        return DoctorCheck(
            name="runtime-reachable",
            severity=Severity.FAIL,
            msg=f"BoxLite runtime not responding: {type(e).__name__}: {e}",
            hint="Check `boxlite serve` / lockfile state.",
        )


def check_port_free(port: int) -> DoctorCheck:
    """Pass if no listener on `port`, OR the listener's command starts with `boxlite`."""
    name = f"port-{port}-free"
    if not shutil.which("lsof"):
        return DoctorCheck(
            name=name,
            severity=Severity.FAIL,
            msg="lsof not found; cannot verify port availability",
            hint="Install lsof (it's preinstalled on macOS — check your $PATH).",
        )
    proc = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-F", "pcLn"],
        capture_output=True,
        text=True,
        check=False,
    )
    # lsof exits 1 when nothing is listening. That's the happy path.
    # If stderr is non-empty on a non-zero exit, lsof actually errored — fail
    # the check rather than silently report "free".
    if proc.returncode != 0 and not proc.stdout.strip():
        if proc.stderr.strip():
            return DoctorCheck(
                name=name,
                severity=Severity.FAIL,
                msg=f"lsof exited {proc.returncode}: {proc.stderr.strip()[:120]}",
                hint="Check lsof permissions / availability; cannot verify port conflict otherwise.",
            )
        return DoctorCheck(
            name=name,
            severity=Severity.OK,
            msg=f"port {port} is free",
        )
    rows = _parse_lsof_F(proc.stdout)
    foreign = [r for r in rows if not _is_boxlite_owner(r.cmd)]
    if foreign:
        r = foreign[0]
        return DoctorCheck(
            name=name,
            severity=Severity.FAIL,
            msg=f"port {port} held by `{r.cmd}` (PID {r.pid}, user {r.user})",
            hint="Change the host port in InfraConfig or stop the local service.",
        )
    return DoctorCheck(
        name=name,
        severity=Severity.OK,
        msg=f"port {port} free (or held only by boxlite)",
    )


async def doctor(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    strict: bool = True,
) -> DoctorReport:
    """Run preflight checks. Raises DoctorError if strict and any FAIL."""
    checks: list[DoctorCheck] = []
    checks.append(check_sdk_importable())
    if checks[-1].severity != Severity.FAIL:
        checks.append(await check_runtime_reachable())
    for spec in services.values():
        for host_port, _ in spec.ports:
            checks.append(check_port_free(host_port))

    report = DoctorReport(checks=checks)
    if strict and report.any_fail():
        raise DoctorError(report)
    return report


def format_report(report: DoctorReport) -> str:
    """Pretty-print a DoctorReport for the CLI doctor subcommand."""
    marker = {Severity.OK: "✓", Severity.FAIL: "✗", Severity.WARN: "⚠"}
    lines: list[str] = []
    for c in report.checks:
        lines.append(f"  {marker[c.severity]} {c.name:<24} {c.msg}")
        if c.severity != Severity.OK and c.hint:
            lines.append(f"        → {c.hint}")
    return "\n".join(lines)
