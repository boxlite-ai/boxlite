"""Exercise Swarm readiness and host validation without starting guests."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests/docker"))
import acceptance
import swarm


def result(code=0, stdout=""):
    return {"code": code, "stdout": stdout, "stderr": ""}


def task(state="running", node="node-a"):
    return json.dumps([{"Status": {"State": state}, "NodeID": node}])


class ServicesReadyTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.scene = acceptance.Scene(
            SimpleNamespace(output=Path(scratch.name)), "single"
        )
        self.worker = SimpleNamespace(call=AsyncMock())
        self.scene.boxes = [(self.worker, "manager")]

    async def test_retries_transient_query_failures(self):
        for command in ("ps", "inspect"):
            with self.subTest(command=command):
                responses = [result(1)]
                if command == "inspect":
                    responses.insert(0, result(stdout="task-a"))
                responses += [result(stdout="task-a"), result(stdout=task())]
                self.worker.call = AsyncMock(side_effect=responses)
                clock = SimpleNamespace(monotonic=Mock(side_effect=[0, 119.5]))
                sleep = AsyncMock()
                with (
                    patch.object(swarm, "time", clock),
                    patch.object(swarm, "asyncio", SimpleNamespace(sleep=sleep)),
                ):
                    await swarm.services_ready(self.scene, {"backend": "node-a"})
                self.assertEqual(self.worker.call.await_count, len(responses))
                sleep.assert_awaited_once_with(0.5)

    async def test_query_failures_time_out_at_existing_deadline(self):
        for command in ("ps", "inspect"):
            with self.subTest(command=command):
                attempt = [result(1)]
                if command == "inspect":
                    attempt.insert(0, result(stdout="task-a"))
                self.worker.call = AsyncMock(side_effect=attempt * 2)
                clock = SimpleNamespace(monotonic=Mock(side_effect=[0, 119.5, 120]))
                sleep = AsyncMock()
                with (
                    patch.object(swarm, "time", clock),
                    patch.object(swarm, "asyncio", SimpleNamespace(sleep=sleep)),
                    self.assertRaisesRegex(TimeoutError, "constrained running replicas"),
                ):
                    await swarm.services_ready(self.scene, {"backend": "node-a"})
                self.assertEqual(self.worker.call.await_count, len(attempt) * 2)
                sleep.assert_awaited_once_with(0.5)

    async def test_waits_for_running_task_on_constrained_node(self):
        self.worker.call.side_effect = [
            result(stdout="task-a"),
            result(stdout=task(state="starting")),
            result(stdout="task-a"),
            result(stdout=task(node="node-b")),
            result(stdout="task-a"),
            result(stdout=task()),
        ]
        clock = SimpleNamespace(monotonic=Mock(side_effect=[0, 0, 0]))
        sleep = AsyncMock()
        with (
            patch.object(swarm, "time", clock),
            patch.object(swarm, "asyncio", SimpleNamespace(sleep=sleep)),
        ):
            await swarm.services_ready(self.scene, {"backend": "node-a"})
        self.assertEqual(self.worker.call.await_count, 6)
        self.assertEqual(sleep.await_count, 2)


class HostValidationReached(Exception):
    """Stop before guest preparation after the coordinator validates both hosts."""


class CrossRunnerIdentityTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.args = SimpleNamespace(
            output=Path(scratch.name),
            topology="cross-runner",
            runner_a="user@host-a",
            runner_b="user@host-b",
            download_proxy=None,
        )
        self.scene = acceptance.Scene(self.args, self.args.topology)
        self.workers = [
            SimpleNamespace(
                identity={
                    "runner": runner,
                    "machine_id": machine,
                    "hostname": "worker",
                },
                call=AsyncMock(return_value={"box": machine}),
            )
            for runner, machine in [
                ("runner-a", "machine-a"),
                ("runner-b", "machine-b"),
            ]
        ]

    async def validate_hosts(self):
        with (
            patch.object(swarm, "Scene", return_value=self.scene),
            patch.object(
                acceptance.RemoteWorker, "start", AsyncMock(side_effect=self.workers)
            ),
            patch.object(
                self.scene, "prepare", AsyncMock(side_effect=HostValidationReached)
            ),
            patch.object(self.scene, "finish", AsyncMock()),
        ):
            await swarm.swarm(self.args)

    async def test_distinct_hosts_may_share_a_hostname(self):
        with self.assertRaises(HostValidationReached):
            await self.validate_hosts()
        self.assertEqual(len(self.scene.boxes), 2)

    async def test_rejects_the_same_runner(self):
        self.workers[1].identity["runner"] = self.workers[0].identity["runner"]
        with self.assertRaises(AssertionError):
            await self.validate_hosts()
        self.assertEqual(len(self.scene.boxes), 1)

    async def test_rejects_the_same_machine(self):
        self.workers[1].identity["machine_id"] = "machine-a"
        with self.assertRaisesRegex(AssertionError, "different physical hosts"):
            await self.validate_hosts()
        self.assertEqual(len(self.scene.boxes), 1)


if __name__ == "__main__":
    unittest.main()
