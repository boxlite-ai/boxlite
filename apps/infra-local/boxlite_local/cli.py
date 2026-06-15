"""argparse CLI dispatch for `python -m boxlite_local`.

Thin layer: parse args, call into orchestrator/doctor, map results to exit code.
Tests call the underlying async functions directly — they don't go through this.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from .config import InfraConfig
from .doctor import doctor, format_report
from .orchestrator import down, ensure_home_env, ps, up
from .services import SERVICES
from .types import DoctorError


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="boxlite_local",
        description="BoxLite-based infra-local orchestrator (Phase 2 walking skeleton).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="Run preflight checks.")

    p_up = sub.add_parser("up", help="Bring services up.")
    p_up.add_argument("services", nargs="*", help="Subset of services (default: all)")
    p_up.add_argument("--skip-doctor", action="store_true", help="Bypass preflight checks")

    p_down = sub.add_parser("down", help="Stop + remove services.")
    p_down.add_argument("services", nargs="*", help="Subset of services (default: all)")
    p_down.add_argument("--wipe", action="store_true", help="Also remove the data dir")

    sub.add_parser("ps", help="List boxlite-local-* boxes.")

    return parser


async def _cmd_doctor(config: InfraConfig) -> int:
    report = await doctor(config, SERVICES, strict=False)
    print(format_report(report))
    return 1 if report.any_fail() else 0


async def _cmd_up(config: InfraConfig, names: list[str], skip_doctor: bool) -> int:
    only = names or None
    try:
        await up(config, SERVICES, only=only, skip_doctor=skip_doctor)
    except DoctorError as e:
        print("doctor preflight failed:", file=sys.stderr)
        print(format_report(e.report), file=sys.stderr)
        return 1
    return 0


async def _cmd_down(config: InfraConfig, names: list[str], wipe: bool) -> int:
    only = names or None
    await down(config, SERVICES, only=only, wipe=wipe)
    return 0


async def _cmd_ps(config: InfraConfig) -> int:
    await ps(config)
    return 0


async def _async_main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    config = InfraConfig.load()
    # Pin BOXLITE_HOME before any subcommand touches Boxlite.default() —
    # the standalone `doctor` builds it via check_runtime_reachable.
    ensure_home_env(config)
    if args.cmd == "doctor":
        return await _cmd_doctor(config)
    if args.cmd == "up":
        return await _cmd_up(config, args.services, args.skip_doctor)
    if args.cmd == "down":
        return await _cmd_down(config, args.services, args.wipe)
    if args.cmd == "ps":
        return await _cmd_ps(config)
    return 2  # unreachable — argparse already required cmd


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(_async_main(argv))
