"""Exercise the benchmark's SDK orchestration without booting a VM."""

import argparse
import asyncio
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import startup


def arguments(output):
    return argparse.Namespace(
        image="example.test/workload@sha256:" + "a" * 64,
        output=output,
        runs=1,
        batch=2,
        cpus=1,
        memory_mib=512,
        timeout=1,
        interface=None,
        network_label="test",
        command=["true"],
    )


class Measurements(unittest.TestCase):
    def test_unreadable_disk_tree_is_not_reported_as_zero_bytes(self):
        def unreadable(_root, **kwargs):
            if kwargs.get("onerror"):
                kwargs["onerror"](PermissionError("unreadable cache"))
            return iter(())

        with (
            patch.object(startup.os, "walk", side_effect=unreadable),
            self.assertRaises(PermissionError),
        ):
            startup.allocated_bytes(Path("unused"))

    def test_p95_and_separate_scenarios(self):
        rows = [
            {
                "cache": cache,
                "count": count,
                "batch_complete_ms": value,
                "samples": [{"task_complete_ms": value, "image_prepare_ms": value / 2}],
            }
            for cache, count, value in [("cold", 1, n) for n in range(1, 21)]
            + [("warm", 2, 100)]
        ]
        summaries = startup.summarize(rows)
        self.assertEqual(summaries[0]["task_complete"]["p95_ms"], 19)
        self.assertEqual(summaries[0]["task_complete"]["count"], 20)
        self.assertEqual(summaries[1]["task_complete"]["median_ms"], 100)

    def test_disk_counts_allocations_once_and_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "payload"
            payload.write_bytes(b"x" * 8192)
            (root / "hardlink").hardlink_to(payload)
            (root / "symlink").symlink_to(payload)
            (root / "loop").symlink_to(root, target_is_directory=True)
            self.assertEqual(
                startup.allocated_bytes(root), payload.stat().st_blocks * 512
            )

    def test_bad_arguments_fail_before_sdk_import(self):
        base = [
            "--image",
            "example.test/workload@sha256:" + "a" * 64,
            "--output",
            "unused",
            "--network-label",
            "test",
        ]
        with (
            patch.object(startup.sys, "platform", "darwin"),
            redirect_stderr(io.StringIO()),
        ):
            for extra in (
                ["--timeout", "nan"],
                ["--batch", "0"],
                ["--interface", "../escape"],
                ["--runs", "0"],
                ["--image", "alpine:latest"],
            ):
                with self.subTest(extra=extra), self.assertRaises(SystemExit):
                    startup.parse_args(base + extra + ["--", "true"])
            with self.assertRaises(SystemExit):
                startup.parse_args(base)
        with (
            patch.object(startup.sys, "platform", "linux"),
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            startup.parse_args(base + ["--", "true"])


class Orchestration(unittest.IsolatedAsyncioTestCase):
    def runtime(self):
        return SimpleNamespace(
            list_info=AsyncMock(return_value=[SimpleNamespace(id="box")]),
            remove=AsyncMock(),
            shutdown=AsyncMock(),
        )

    async def test_task_waits_for_exit_and_drains_both_streams(self):
        drained = set()

        async def stream(name):
            drained.add(name)
            yield "discard this output"

        async def wait():
            self.assertEqual(drained, {"stdout", "stderr"})
            return SimpleNamespace(exit_code=0, error_message=None)

        execution = SimpleNamespace(
            stdin=lambda: SimpleNamespace(close=AsyncMock()),
            stdout=lambda: stream("stdout"),
            stderr=lambda: stream("stderr"),
            wait=wait,
        )
        box = SimpleNamespace(
            id="box",
            exec=AsyncMock(return_value=execution),
            metrics=AsyncMock(return_value=SimpleNamespace(stage_image_prepare_ms=12)),
        )
        runtime = SimpleNamespace(create=AsyncMock(return_value=box))
        sdk = SimpleNamespace(BoxOptions=Mock())
        with patch.object(startup.time, "perf_counter", return_value=2):
            result = await startup.run_box(runtime, sdk, arguments(Path("unused")), 1)
        self.assertEqual(result["task_complete_ms"], 1000)
        self.assertEqual(result["image_prepare_ms"], 12)
        self.assertFalse(sdk.BoxOptions.call_args.kwargs["auto_remove"])
        execution.wait = AsyncMock(
            return_value=SimpleNamespace(exit_code=7, error_message=None)
        )
        with self.assertRaisesRegex(RuntimeError, "exit code 7"):
            await startup.run_box(runtime, sdk, arguments(Path("unused")), 1)

    async def test_batch_timeout_cancels_all_samples_and_cleans_pending_boxes(self):
        runtime = self.runtime()
        cancelled = []

        async def pending(*_):
            try:
                await asyncio.Future()
            finally:
                cancelled.append(True)

        args = arguments(Path("unused"))
        args.timeout = 0.01
        with (
            patch.object(startup, "run_box", side_effect=pending),
            patch.object(startup, "allocated_bytes", return_value=0),
            self.assertRaises(asyncio.TimeoutError),
        ):
            await startup.run_batch(runtime, None, args, args.output, 2)
        self.assertEqual(len(cancelled), 2)
        runtime.remove.assert_awaited_once_with("box", force=True)

    async def test_counter_reset_fails_and_still_cleans(self):
        runtime = self.runtime()
        with (
            patch.object(startup, "run_box", new=AsyncMock(return_value={})),
            patch.object(startup, "allocated_bytes", return_value=0),
            patch.object(startup, "received_bytes", side_effect=[100, 50]),
            self.assertRaisesRegex(RuntimeError, "counter reset"),
        ):
            await startup.run_batch(
                runtime, None, arguments(Path("unused")), Path("unused"), 1
            )
        runtime.remove.assert_awaited_once()

    async def test_cold_warm_share_only_their_own_home_and_output_is_not_overwritten(
        self,
    ):
        homes = []

        def create_runtime(options):
            home = Path(options.home_dir)
            self.assertFalse(home.exists())
            home.mkdir()
            homes.append(home)
            runtime = self.runtime()
            runtime.home = home
            return runtime

        async def batch(runtime, _sdk, _args, home, count):
            marker = home / "cache"
            cache = "warm" if marker.exists() else "cold"
            marker.touch()
            self.assertEqual(runtime.home, home)
            self.assertEqual(cache, "cold" if len(calls) % 2 == 0 else "warm")
            calls.append((home, count))
            return {
                "samples": [{"task_complete_ms": 2, "image_prepare_ms": 1}],
                "batch_complete_ms": 3,
            }

        calls = []
        sdk = SimpleNamespace(
            Options=SimpleNamespace, Boxlite=create_runtime, __version__="test"
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            redirect_stdout(io.StringIO()),
            patch.object(startup, "run_batch", side_effect=batch),
        ):
            args = arguments(Path(directory) / "result")
            await startup.benchmark(args, sdk)
            report = json.loads((args.output / "results.json").read_text())
            self.assertEqual(report["status"], "ok")
            self.assertEqual(len(report["summary"]), 4)
            self.assertEqual(len(homes), 2)
            self.assertTrue(all(not home.exists() for home in homes))
            with self.assertRaises(FileExistsError):
                await startup.benchmark(args, sdk)

    async def test_failed_shutdown_retains_home_and_reports_failure(self):
        runtime = self.runtime()
        runtime.shutdown.side_effect = RuntimeError("sensitive SDK error")

        def create_runtime(options):
            Path(options.home_dir).mkdir()
            return runtime

        sdk = SimpleNamespace(
            Options=SimpleNamespace, Boxlite=create_runtime, __version__="test"
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                startup, "run_batch", new=AsyncMock(side_effect=ValueError("failed"))
            ),
        ):
            args = arguments(Path(directory) / "result")
            with self.assertRaises(RuntimeError):
                await startup.benchmark(args, sdk)
            text = (args.output / "results.json").read_text()
            report = json.loads(text)
            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["active_batch"]["cache"], "cold")
            self.assertTrue(Path(report["active_home"]).is_dir())
            self.assertNotIn("sensitive", text)
            self.assertEqual(report["summary"], [])


if __name__ == "__main__":
    unittest.main()
