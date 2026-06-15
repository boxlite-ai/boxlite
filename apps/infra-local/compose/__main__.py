"""CLI entry point for `python -m compose`.

One unified orchestrator over L1 (BoxLite boxes — orchestrator.py / services.py)
and L2 (native host processes — native.py). Seven verbs:

    up · down · status · logs · restart · reset · nuke

`up` is self-contained — it installs deps, builds missing binaries, runs the
preflight checks, brings L1 up, starts L2, and seeds init data — so there are no
separate build/seed/doctor/migrate/rebuild commands. `restart` both bounces L2
procs (rebuilding the Go binary) and recreates a single wedged L1 box; `nuke` is
the full teardown.

Dispatch is synchronous; each command runs its own `asyncio.run` for whatever L1
work it needs (the SDK runtime singleton is bound to one event loop).
"""

from __future__ import annotations

import argparse
import sys

from . import native
from .config import InfraConfig
from .doctor import DoctorError
from .orchestrator import ensure_home_env

_COMPONENTS = "api|runner|proxy|dashboard"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="compose",
        description="Local dev-stack orchestrator (L1 BoxLite boxes + L2 native processes).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_up = sub.add_parser("up", help="Ensure L1 boxes up + start L2 native processes (self-healing).")
    p_up.add_argument("components", nargs="*", help=f"Subset of L2 components ({_COMPONENTS}); default all")

    p_down = sub.add_parser("down", help="Stop L2 native processes (L1 boxes stay up).")
    p_down.add_argument("components", nargs="*", help="Subset (default: all)")
    p_down.add_argument("--all", action="store_true", help="Also stop + remove L1 boxes (data volumes kept)")

    sub.add_parser("status", help="One-screen L1 + L2 health.")

    p_logs = sub.add_parser("logs", help="Tail a component log (or 'all'; omit to list).")
    p_logs.add_argument("component", nargs="?", help=f"{_COMPONENTS}|all")

    p_restart = sub.add_parser("restart", help="Restart L2 process(es) and/or recreate L1 box(es) by name.")
    p_restart.add_argument("names", nargs="+", help=f"{_COMPONENTS} (procs) or an L1 box (dex|registry|...)")

    p_reset = sub.add_parser("reset", help="Wipe L2 runtime state; --hard also drops + rebuilds the schema.")
    p_reset.add_argument("--hard", action="store_true", help="Also drop + rebuild the schema (identity wiped)")

    sub.add_parser("nuke", help="Tear down EVERYTHING: destroy L1 boxes + wipe data + logs (cold start).")

    return parser


def _dispatch(args: argparse.Namespace, cfg: InfraConfig) -> int:
    cmd = args.cmd
    if cmd == "up":
        return native.up(cfg, args.components or None)
    if cmd == "down":
        return native.down(cfg, args.components or None, include_l1=args.all)
    if cmd == "status":
        return native.status(cfg)
    if cmd == "logs":
        return native.logs(cfg, args.component)
    if cmd == "restart":
        return native.restart(cfg, args.names)
    if cmd == "reset":
        return native.reset(cfg, hard=args.hard)
    if cmd == "nuke":
        return native.nuke(cfg)
    return 2  # unreachable — argparse required a subcommand


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    cfg = InfraConfig.load()
    # Pin BOXLITE_HOME before anything builds a Boxlite.default() singleton.
    ensure_home_env(cfg)
    try:
        return _dispatch(args, cfg)
    except DoctorError as e:
        print(f"doctor preflight failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
