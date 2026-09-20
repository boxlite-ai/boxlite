"""Opt-in image startup baseline; see README.md for measurement boundaries."""

import argparse
import asyncio
import json
import math
import os
import platform
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path


def allocated_bytes(root):
    """Count allocated blocks once per inode, without following symlinks."""

    def fail(error):
        raise error

    seen = set()
    total = 0
    for directory, _, files in os.walk(root, onerror=fail):
        for name in files:
            path = Path(directory) / name
            stat = path.lstat()
            inode = (stat.st_dev, stat.st_ino)
            if not path.is_symlink() and inode not in seen:
                total += stat.st_blocks * 512
                seen.add(inode)
    return total


def received_bytes(interface):
    if interface is None:
        return None
    return int(Path(f"/sys/class/net/{interface}/statistics/rx_bytes").read_text())


def statistics_ms(values):
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "median_ms": statistics.median(ordered),
        "p95_ms": ordered[math.ceil(len(ordered) * 0.95) - 1],
    }


async def discard(stream):
    async for _ in stream:
        pass


async def run_box(runtime, sdk, args, started):
    box = await runtime.create(
        sdk.BoxOptions(
            image=args.image,
            cpus=args.cpus,
            memory_mib=args.memory_mib,
            auto_remove=False,
            detach=False,
        )
    )
    execution = await box.exec(
        args.command[0], args.command[1:], timeout_secs=args.timeout
    )
    await execution.stdin().close()

    async def wait():
        result = await execution.wait()
        return result, (time.perf_counter() - started) * 1000

    # Drain both streams while waiting: a verbose task must not fill its pipes.
    tasks = [
        asyncio.create_task(coro)
        for coro in (
            discard(execution.stdout()),
            discard(execution.stderr()),
            wait(),
        )
    ]
    try:
        _, _, (result, elapsed) = await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    if result.exit_code != 0 or result.error_message:
        raise RuntimeError(f"workload failed with exit code {result.exit_code}")
    metrics = await box.metrics()
    if metrics.stage_image_prepare_ms is None:
        raise RuntimeError("image preparation metric is unavailable")
    return {
        "box_id": box.id,
        "task_complete_ms": elapsed,
        "image_prepare_ms": metrics.stage_image_prepare_ms,
    }


async def run_batch(runtime, sdk, args, home, count):
    disk_before = allocated_bytes(home)
    rx_before = received_bytes(args.interface)
    started = time.perf_counter()
    tasks = [
        asyncio.create_task(run_box(runtime, sdk, args, started)) for _ in range(count)
    ]
    try:
        rows = await asyncio.wait_for(asyncio.gather(*tasks), args.timeout)
        elapsed = (time.perf_counter() - started) * 1000
        rx_after = received_bytes(args.interface)
        if rx_before is not None and rx_after < rx_before:
            raise RuntimeError("network counter reset during measurement")
        return {
            "samples": rows,
            "batch_complete_ms": elapsed,
            "host_rx_bytes": None if rx_before is None else rx_after - rx_before,
            "disk_before_bytes": disk_before,
            "disk_after_bytes": allocated_bytes(home),
        }
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        # An interrupted create can leave a DB row without returning a handle.
        async def remove_boxes():
            for box in await runtime.list_info():
                await runtime.remove(box.id, force=True)

        await asyncio.wait_for(remove_boxes(), 30)


def summarize(batches):
    summaries = []
    for cache, count in dict.fromkeys((row["cache"], row["count"]) for row in batches):
        matching = [
            row for row in batches if row["cache"] == cache and row["count"] == count
        ]
        samples = [sample for row in matching for sample in row["samples"]]
        summaries.append(
            {
                "cache": cache,
                "count": count,
                "batches": len(matching),
                "task_complete": statistics_ms(
                    [row["task_complete_ms"] for row in samples]
                ),
                "image_prepare": statistics_ms(
                    [row["image_prepare_ms"] for row in samples]
                ),
                "batch_complete": statistics_ms(
                    [row["batch_complete_ms"] for row in matching]
                ),
            }
        )
    return summaries


async def benchmark(args, sdk):
    args.output.mkdir(parents=True, exist_ok=False)
    report = {
        "schema_version": 1,
        "status": "running",
        "config": {
            **vars(args),
            "output": str(args.output),
        },
        "host": {
            "os": platform.platform(),
            "architecture": platform.machine(),
            "cpus": os.cpu_count(),
            "memory_bytes": os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"),
        },
        "sdk_version": sdk.__version__,
        "started_at_unix": time.time(),
        "conversion_ms": None,
        "batches": [],
    }
    try:
        commit = await asyncio.to_thread(
            subprocess.run,
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        report["git_commit"] = commit.stdout.strip()
        for count in (1, args.batch):
            for iteration in range(1, args.runs + 1):
                home = args.output / f"home-{count}-{iteration}"
                report["active_home"] = str(home)
                runtime = sdk.Boxlite(sdk.Options(home_dir=str(home)))
                try:
                    for cache in ("cold", "warm"):
                        report["active_batch"] = {
                            "cache": cache,
                            "count": count,
                            "iteration": iteration,
                        }
                        result = await run_batch(runtime, sdk, args, home, count)
                        report["batches"].append(
                            {
                                "cache": cache,
                                "count": count,
                                "iteration": iteration,
                                **result,
                            }
                        )
                        report.pop("active_batch")
                        print(
                            f"{cache} count={count} iteration={iteration}: "
                            f"{result['batch_complete_ms']:.0f} ms",
                            flush=True,
                        )
                        (args.output / "results.json").write_text(
                            json.dumps(report, indent=2) + "\n"
                        )
                finally:
                    # Keep the home for diagnosis if shutdown fails; never unlink a live VM disk.
                    await asyncio.wait_for(runtime.shutdown(timeout=20), 30)
                del runtime
                shutil.rmtree(home)
                report.pop("active_home")
        report["status"] = "ok"
    except BaseException as error:
        report["status"] = "failed"
        # SDK errors can contain registry credentials or workload output.
        report["error_type"] = type(error).__name__
        raise
    finally:
        report["summary"] = summarize(report["batches"])
        (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--image", required=True, help="image pinned with @sha256:<64 hex digits>"
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="new result directory (must not exist)",
    )
    parser.add_argument(
        "--runs", type=int, default=5, help="cold/warm pairs per batch size"
    )
    parser.add_argument("--batch", type=int, default=4, help="parallel boxes, 2..64")
    parser.add_argument("--cpus", type=int, default=1)
    parser.add_argument("--memory-mib", type=int, default=512)
    parser.add_argument(
        "--timeout", type=float, default=600, help="seconds per batch including startup"
    )
    parser.add_argument(
        "--interface", help="Linux registry-facing interface; required on Linux"
    )
    parser.add_argument(
        "--network-label",
        required=True,
        help="network conditions, e.g. dedicated-1Gbps",
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="-- executable [arguments] inside each box",
    )
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", args.image):
        parser.error("--image must be pinned by sha256 digest")
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command:
        parser.error("supply a finite workload after --")
    if not 1 <= args.runs <= 1000 or not 2 <= args.batch <= 64:
        parser.error("--runs must be 1..1000 and --batch must be 2..64")
    if not 1 <= args.cpus <= 255 or not 1 <= args.memory_mib <= 2**32 - 1:
        parser.error("invalid box CPU or memory limit")
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    if sys.platform == "linux" and args.interface is None:
        parser.error("--interface is required on Linux to measure host receive bytes")
    if args.interface is not None:
        if not re.fullmatch(r"[\w.:-]+", args.interface):
            parser.error("invalid interface name")
        try:
            received_bytes(args.interface)
        except (OSError, ValueError):
            parser.error("cannot read the Linux receive counter for --interface")
    args.output = args.output.resolve()
    return args


if __name__ == "__main__":
    arguments = parse_args(
        sys.argv[1:] or shlex.split(os.environ.get("STARTUP_ARGS", ""))
    )
    try:
        import boxlite

        asyncio.run(benchmark(arguments, boxlite))
    # Suppress arbitrary SDK exception text: it can include credentials.
    except (Exception, KeyboardInterrupt) as error:  # noqa: BLE001
        print(
            f"Benchmark failed ({type(error).__name__}); inspect the result directory.",
            file=sys.stderr,
        )
        sys.exit(1)
