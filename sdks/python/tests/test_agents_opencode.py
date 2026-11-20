"""Real OpenCode agent flow through the Python binding."""

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import boxlite
from boxlite import (
    AgentCreateOptions,
    AgentSendOptions,
    AgentWaitOptions,
    InvalidArgumentError,
    UnsupportedError,
)


def assert_rust_parity(result, event, turn_id):
    path = os.environ.get("BOXLITE_AGENT_RUST_BASELINE")
    if not path:
        return
    baseline = json.loads(Path(path).read_text())
    assert baseline["result"]["turn_id"] == baseline["turn_id"]
    assert baseline["event"]["turn_id"] == baseline["turn_id"]
    assert result["turn_id"] == event["turn_id"] == turn_id
    assert event["kind"] == baseline["event"]["kind"]
    actual = json.loads(json.dumps(result))
    expected = baseline["result"]
    for record in (actual, expected):
        del record["turn_id"]
        for entry in record["usage"] or []:
            assert entry.pop("message_id")
    assert actual == expected


class FakeModel(BaseHTTPRequestHandler):
    def log_message(self, _format, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if not request.get("stream"):
            body = json.dumps(
                {
                    "id": "c",
                    "object": "chat.completion",
                    "model": "fake-model",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "title"},
                            "finish_reason": "stop",
                        }
                    ],
                }
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        messages = request["messages"]
        prompt = next(
            (
                message["content"]
                for message in reversed(messages)
                if message["role"] == "user"
            ),
            "",
        )
        if not isinstance(prompt, str):
            prompt = "".join(part.get("text", "") for part in prompt)
        chunks = [
            {
                "id": "c",
                "object": "chat.completion.chunk",
                "model": "fake-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": f"pong: {prompt}"},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "c",
                "object": "chat.completion.chunk",
                "model": "fake-model",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
        ]
        payload = (
            "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
            + "data: [DONE]\n\n"
        )
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(payload.encode())


@pytest.mark.integration
@pytest.mark.asyncio
async def test_python_agent_opencode_flow(tmp_path, test_registries):
    binary = os.environ.get("BOXLITE_TEST_OPENCODE_BINARY")
    if not binary:
        pytest.skip("set BOXLITE_TEST_OPENCODE_BINARY to OpenCode 2.2.2")
    server = ThreadingHTTPServer(("0.0.0.0", 0), FakeModel)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    runtime = boxlite.Boxlite(
        boxlite.Options(
            home_dir=str(tmp_path / "home"), image_registries=test_registries
        )
    )
    try:
        box = await runtime.create(boxlite.BoxOptions(image="debian:bookworm-slim"))
        await box.start()
        await box.copy_in(binary, "/usr/local/bin/opencode")
        command = await box.exec(
            "sh",
            [
                "-c",
                "chmod 755 /usr/local/bin/opencode && mkdir -p /root/.config/opencode",
            ],
        )
        assert (await command.wait()).exit_code == 0
        config = {
            "provider": {
                "fake": {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Fake",
                    "options": {
                        "baseURL": f"http://host.boxlite.internal:{server.server_port}/v1",
                        "apiKey": "fake",
                    },
                    "models": {"fake-model": {"name": "Fake"}},
                }
            },
            "small_model": "fake/fake-model",
        }
        path = tmp_path / "opencode.json"
        path.write_text(json.dumps(config))
        await box.copy_in(str(path), "/root/.config/opencode/opencode.json")
        agent = await box.agents.create(
            "opencode", AgentCreateOptions(config={"model": "fake/fake-model"})
        )
        assert agent.config["model"] == "fake/fake-model"
        assert "agent.capabilities" in agent.capabilities["operations"]
        with pytest.raises(UnsupportedError):
            _ = agent.state
        with pytest.raises(InvalidArgumentError):
            await agent.send("invalid", AgentSendOptions(mode="invalid"))
        events = agent.events()
        await asyncio.wait_for(events.opened(), 30)
        turn = await agent.send("hello")
        result = await turn.wait(AgentWaitOptions(timeout=120))
        assert result["status"] == "completed"
        assert result["text"] == "pong: hello"
        assert result["turn_id"] == turn.state["id"]
        assert result["outcome"] == "answer"
        assert result["data"] is None
        assert result["artifacts"] == []
        assert result["error"] is None
        usage = result["usage"]
        assert len(usage) == 1
        assert usage[0]["message_id"]
        assert {k: v for k, v in usage[0].items() if k != "message_id"} == {
            "cost": 0,
            "tokens": {
                "cache": {"read": 0, "write": 0},
                "input": 0,
                "output": 0,
                "reasoning": 0,
            },
        }
        for timeout in (-1, float("inf"), float("nan")):
            with pytest.raises(InvalidArgumentError):
                await turn.wait(AgentWaitOptions(timeout=timeout))
        with pytest.raises(UnsupportedError):
            await turn.steer("unsupported")
        with pytest.raises(UnsupportedError):
            await turn.interrupt()
        with pytest.raises(UnsupportedError):
            await agent.requests()
        with pytest.raises(UnsupportedError):
            await agent.respond("request", {"type": "answer", "text": "yes"})
        with pytest.raises(InvalidArgumentError):
            await agent.respond("request", {"type": "invalid"})
        with pytest.raises(UnsupportedError):
            await agent.close()

        event = await asyncio.wait_for(anext(events), 30)
        assert event["kind"] == "session.inbox.enqueued"
        assert event["turn_id"] == turn.state["id"]
        assert_rust_parity(result, event, turn.state["id"])
        reattached = await box.agents.get(event["agent_id"])
        finished = await reattached.get_turn(event["turn_id"])
        assert finished.state["status"] == "completed"
        await events.aclose()
        idle = agent.events()
        await asyncio.wait_for(idle.opened(), 30)
        pending = asyncio.create_task(anext(idle))
        await asyncio.sleep(0.1)
        await asyncio.wait_for(idle.aclose(), 5)
        with pytest.raises((asyncio.CancelledError, StopAsyncIteration)):
            await pending
        with pytest.raises(UnsupportedError):
            await agent.send("unsupported", AgentSendOptions(data={"x": 1}))
        unsupported = turn.events()
        with pytest.raises(UnsupportedError):
            await unsupported.opened()
        await unsupported.aclose()
    finally:
        await runtime.shutdown()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.integration
def test_sync_python_agent_opencode_flow(tmp_path, test_registries):
    binary = os.environ.get("BOXLITE_TEST_OPENCODE_BINARY")
    if not binary:
        pytest.skip("set BOXLITE_TEST_OPENCODE_BINARY to OpenCode 2.2.2")
    server = ThreadingHTTPServer(("0.0.0.0", 0), FakeModel)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    options = boxlite.Options(
        home_dir=str(tmp_path / "home"), image_registries=test_registries
    )
    try:
        with boxlite.SyncBoxlite(options) as runtime:
            box = runtime.create(boxlite.BoxOptions(image="debian:bookworm-slim"))
            box.start()
            box._sync(box._box.copy_in(binary, "/usr/local/bin/opencode"))
            command = box.exec(
                "sh",
                [
                    "-c",
                    "chmod 755 /usr/local/bin/opencode && mkdir -p /root/.config/opencode",
                ],
            )
            assert command.wait().exit_code == 0
            config = {
                "provider": {
                    "fake": {
                        "npm": "@ai-sdk/openai-compatible",
                        "name": "Fake",
                        "options": {
                            "baseURL": f"http://host.boxlite.internal:{server.server_port}/v1",
                            "apiKey": "fake",
                        },
                        "models": {"fake-model": {"name": "Fake"}},
                    }
                },
                "small_model": "fake/fake-model",
            }
            path = tmp_path / "opencode.json"
            path.write_text(json.dumps(config))
            box._sync(
                box._box.copy_in(str(path), "/root/.config/opencode/opencode.json")
            )
            agent = box.agents.create(
                "opencode", AgentCreateOptions(config={"model": "fake/fake-model"})
            )
            events = agent.events()
            events.opened()
            turn = agent.send("hello")
            result = turn.wait(AgentWaitOptions(timeout=120))
            assert result["status"] == "completed"
            assert result["text"] == "pong: hello"
            event = next(events)
            assert event["kind"] == "session.inbox.enqueued"
            assert event["turn_id"] == turn.state["id"]
            assert_rust_parity(result, event, turn.state["id"])
            events.close()
            box.stop()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
