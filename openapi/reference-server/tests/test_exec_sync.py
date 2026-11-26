from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from test_handle_cache import SERVER


async def chunks(items):
    for item in items:
        yield item


class ExecSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.execution = SimpleNamespace(
            stdout=lambda: chunks(["hello\n"]),
            stderr=lambda: chunks([b"warning\n"]),
            stdin=lambda: SimpleNamespace(close=self.close_stdin),
            wait=AsyncMock(return_value=SimpleNamespace(exit_code=0, error_message=None)),
            kill=AsyncMock(),
        )
        self.close_stdin = AsyncMock()
        self.box = SimpleNamespace(exec=AsyncMock(return_value=self.execution))
        self.runtime = SimpleNamespace(get=AsyncMock(return_value=None))
        for patcher in (
            patch.object(SERVER, "state", SERVER.AppState()),
            patch.dict(SERVER.app.dependency_overrides, {SERVER.require_auth: lambda: {}}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        SERVER.state.runtime = self.runtime
        SERVER.state.active_boxes_by_id["test-box"] = self.box

    async def post(self, payload, box_id="test-box"):
        # Call the ASGI app directly to exercise routing and validation without httpx.
        path = f"/v1/demo/boxes/{box_id}/exec/sync"
        messages = []

        async def receive():
            return {"type": "http.request", "body": json.dumps(payload).encode()}

        async def send(message):
            messages.append(message)

        await SERVER.app({
            "type": "http", "method": "POST", "path": path,
            "headers": [(b"content-type", b"application/json")],
            "query_string": b"",
        }, receive, send)
        return messages[0]["status"], json.loads(messages[1]["body"])

    async def test_success_forwards_sdk_options_and_closes_stdin(self):
        status, payload = await self.post({
            "command": "echo", "args": ["hello"], "env": {"LANG": "C"},
            "timeout_seconds": 12.0, "working_dir": "/tmp", "user": "1000:1000",
        })
        self.assertEqual(status, 200)
        self.assertEqual(payload, {
            "exit_code": 0, "stdout": "hello\n", "stderr": "warning\n",
            "stdout_truncated": False, "stderr_truncated": False,
        })
        self.box.exec.assert_awaited_once_with(
            "echo", args=["hello"], env=[("LANG", "C")], tty=False,
            cwd="/tmp", user="1000:1000", timeout_secs=17.0,
        )
        self.close_stdin.assert_awaited_once()
        self.assertFalse(SERVER.state.active_executions)

    async def test_nonzero_exit_is_a_result(self):
        self.execution.wait.return_value = SimpleNamespace(
            exit_code=127, error_message="command not found",
        )
        self.execution.stderr = lambda: chunks([b"unknown command\n"])
        status, payload = await self.post({"command": "unknown"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["exit_code"], 127)
        self.assertEqual(payload["stderr"], "unknown command\n")
        self.assertEqual(payload["error_message"], "command not found")

    async def test_each_stream_is_bounded_and_drained_concurrently_with_wait(self):
        waiting, stdout_drained, stderr_drained = (asyncio.Event() for _ in range(3))

        async def stream(first, overflow, drained):
            await waiting.wait()
            yield first
            yield overflow
            yield b"discard this too"
            drained.set()

        async def wait():
            waiting.set()
            await stdout_drained.wait()
            await stderr_drained.wait()
            return SimpleNamespace(exit_code=0, error_message=None)

        self.execution.stdout = lambda: stream(b"a" * 1024, b"overflow", stdout_drained)
        self.execution.stderr = lambda: stream("é" * 513, "overflow", stderr_drained)
        self.execution.wait.side_effect = wait
        status, payload = await self.post({
            "command": "echo", "max_output_bytes": 1024, "timeout_seconds": 1,
        })
        self.assertEqual(status, 200)
        self.assertEqual(payload["stdout"], "a" * 1024)
        self.assertEqual(payload["stderr"], "é" * 512)
        self.assertIs(payload["stdout_truncated"], True)
        self.assertIs(payload["stderr_truncated"], True)
        self.assertTrue(stdout_drained.is_set() and stderr_drained.is_set())

    async def test_invalid_utf8_and_exact_limit(self):
        self.execution.stdout = lambda: chunks([b"\xffa", b"\xe2", b"\x82\xac"])
        self.execution.stderr = lambda: chunks([b"b" * 1024, b""])
        status, payload = await self.post({"command": "echo", "max_output_bytes": 1024})
        self.assertEqual(status, 200)
        self.assertEqual(payload["stdout"], "\ufffda€")
        self.assertEqual(payload["stderr"], "b" * 1024)
        self.assertIs(payload["stdout_truncated"], False)
        self.assertIs(payload["stderr_truncated"], False)

    async def test_timeout_kills_execution_and_cleans_up_readers(self):
        blocked = asyncio.Event()
        closed = []

        async def stream(name):
            try:
                await blocked.wait()
                yield b""
            finally:
                closed.append(name)

        self.execution.stdout = lambda: stream("stdout")
        self.execution.stderr = lambda: stream("stderr")
        self.execution.wait.side_effect = blocked.wait
        self.execution.kill.side_effect = RuntimeError("already exited")
        status, payload = await self.post({"command": "sleep", "timeout_seconds": 0.1})
        self.assertEqual(status, 408)
        self.assertEqual(payload, {"error": {
            "message": "execution timed out", "type": "TimeoutError", "code": "timeout",
        }})
        self.execution.kill.assert_awaited_once()
        self.assertCountEqual(closed, ["stdout", "stderr"])

    async def test_does_not_retry_transient_transport_error(self):
        self.box.exec.side_effect = [RuntimeError("gRPC transport error: retry"), self.execution]
        status, payload = await self.post({"command": "echo"})
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"]["code"], "upstream_unavailable")
        self.assertEqual(self.box.exec.await_count, 1)

    async def test_invalid_requests_never_start_execution(self):
        for fields in (
            {"command": ""}, {"timeout_seconds": 0.09}, {"timeout_seconds": 301},
            {"max_output_bytes": 1023}, {"max_output_bytes": 10485761},
            {"max_output_bytes": 1024.5}, {"tty": True},
        ):
            with self.subTest(fields=fields):
                status, payload = await self.post({"command": "echo", **fields})
                self.assertEqual(status, 400)
                self.assertEqual(payload["error"]["code"], "invalid_argument")
        self.box.exec.assert_not_awaited()

    async def test_missing_box_returns_404(self):
        status, _ = await self.post({"command": "echo"}, box_id="missing")
        self.assertEqual(status, 404)
        self.runtime.get.assert_awaited_once_with("missing")
        self.box.exec.assert_not_awaited()
