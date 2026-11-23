"""Exercise synchronous agent calls without requiring the native extension."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from boxlite.agents import AgentControlOptions, AgentCreateOptions, Agents
from boxlite.sync_api import SyncBoxlite, SyncSimpleBox


def test_sync_agent_calls_and_streams_forward_to_async_handles():
    payload = {"turn_id": "inner", "value": None}
    native_stream = SimpleNamespace(
        next=AsyncMock(
            side_effect=[json.dumps({"kind": "message", "data": payload}), None]
        ),
        close=AsyncMock(),
    )
    native_turn = SimpleNamespace(
        state=json.dumps({"id": "turn", "status": "completed"}),
        wait=AsyncMock(
            return_value=json.dumps({"status": "completed", "data": payload})
        ),
        steer=AsyncMock(
            return_value=json.dumps({"turn_id": "turn", "status": "accepted"})
        ),
        interrupt=AsyncMock(),
        events=AsyncMock(return_value=native_stream),
    )
    native_agent = SimpleNamespace(
        state=json.dumps({"id": "agent"}),
        config=json.dumps({"model": "m"}),
        capabilities=json.dumps({"operations": ["agent.send"]}),
        close=AsyncMock(),
        send=AsyncMock(return_value=native_turn),
        get_turn=AsyncMock(return_value=native_turn),
        requests=AsyncMock(return_value=json.dumps([{"id": "request"}])),
        respond=AsyncMock(return_value=native_turn),
        events=AsyncMock(return_value=native_stream),
    )
    native_agents = SimpleNamespace(
        create=AsyncMock(return_value=native_agent),
        get=AsyncMock(return_value=native_agent),
    )
    context = object.__new__(SyncBoxlite)
    context._adopt(object())
    with context:
        box = object.__new__(SyncSimpleBox)
        box._box = SimpleNamespace(
            _runtime=context,
            _sync=context._sync_helper._sync,
            _box=SimpleNamespace(agents=Agents(native=native_agents)),
        )
        options = AgentCreateOptions(config={"model": "m"})
        agent = box.agents.create("opencode", options)
        assert agent.config == {"model": "m"}
        assert agent.state == {"id": "agent"}
        assert agent.capabilities == {"operations": ["agent.send"]}
        assert box.agents.get("agent").state == {"id": "agent"}
        turn = agent.send("hello")
        assert turn.state == {"id": "turn", "status": "completed"}
        assert turn.wait() == {"status": "completed", "data": payload}
        assert agent.get_turn("turn").state["id"] == "turn"
        assert agent.requests() == [{"id": "request"}]
        assert (
            agent.respond("request", {"type": "answer", "text": "yes"}).state["id"]
            == "turn"
        )
        control = AgentControlOptions(idempotency_key="key")
        assert turn.steer("continue", control)["turn_id"] == "turn"
        turn.interrupt(control)
        stream = agent.events()
        stream.opened()
        assert list(stream) == [{"kind": "message", "data": payload}]
        stream.close()
        turn_stream = turn.events()
        turn_stream.opened()
        turn_stream.close()
        agent.close(control)
        box._box = None
        with pytest.raises(RuntimeError, match="Box not started"):
            box.agents.get("agent")
    native_agents.create.assert_awaited_once_with(
        "opencode", None, '{"model": "m"}', None
    )
    native_agents.get.assert_awaited_once_with("agent")
    native_agent.send.assert_awaited_once_with("hello", "queue", "null", None)
    native_agent.respond.assert_awaited_once()
    native_turn.steer.assert_awaited_once_with("continue", "key")
    native_turn.interrupt.assert_awaited_once_with("key")
    assert native_stream.close.await_count == 2
    native_agent.close.assert_awaited_once_with("key")
