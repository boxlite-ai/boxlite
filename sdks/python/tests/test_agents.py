"""Check agent errors and namespace access across Python and native bindings."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import boxlite
from boxlite.agents import (
    Agent,
    AgentAnswer,
    AgentControlOptions,
    AgentCreateOptions,
    Agents,
)
from boxlite.errors import NotFoundError, UnsupportedError
from boxlite.simplebox import SimpleBox
from boxlite.sync_api import (
    SyncAgents,
    SyncBox,
    SyncSimpleBox,
)


def test_agents_simple_namespace_needs_no_runtime_initialization():
    # Only exercise the property: touching an uninitialized runtime would fail.
    box = object.__new__(SimpleBox)
    assert isinstance(box.agents, Agents)
    assert boxlite.Agent is Agent


@pytest.mark.asyncio
async def test_simplebox_agent_calls_require_started_box():
    box = object.__new__(SimpleBox)
    box._started = False
    with pytest.raises(RuntimeError, match="Box not started"):
        await box.agents.create("opencode")


@pytest.mark.asyncio
async def test_retained_agents_reject_calls_after_context_exit():
    box = object.__new__(SimpleBox)
    box._started = True
    box._box = type("Box", (), {})()
    box._box.__aexit__ = AsyncMock(return_value=True)
    native_create = AsyncMock()
    box._box.agents = SimpleNamespace(_native=SimpleNamespace(create=native_create))
    agents = box.agents
    assert await box.__aexit__(None, None, None) is True
    with pytest.raises(RuntimeError, match="Box not started"):
        await agents.create("opencode")
    native_create.assert_not_awaited()
    box._started = True
    box._box.__aexit__ = AsyncMock(side_effect=RuntimeError("cleanup failed"))
    with pytest.raises(RuntimeError, match="cleanup failed"):
        await box.__aexit__(None, None, None)
    assert box._started


@pytest.mark.parametrize("box_type", [SyncBox, SyncSimpleBox])
def test_agents_sync_namespace_needs_no_runtime_initialization(box_type):
    box = object.__new__(box_type)
    assert isinstance(box.agents, SyncAgents)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_agents_native_box_namespace(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    box = await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
    with pytest.raises(UnsupportedError, match="supported: opencode"):
        await box.agents.create("agent")


@pytest.mark.asyncio
@pytest.mark.integration
async def test_agents_native_box_lookup(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    box = await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
    with pytest.raises(NotFoundError, match="agent missing not found"):
        await box.agents.get("missing")


def test_agents_text_answer_data_is_optional():
    assert AgentAnswer.__required_keys__ == {"type", "text"}
    assert "data" in AgentAnswer.__optional_keys__
    assert boxlite.AgentCreateOptions is AgentCreateOptions


@pytest.mark.asyncio
async def test_requests_and_response_cross_the_python_wrapper():
    payload = {"turn_id": "inside", "value": None}
    request = {
        "id": "r",
        "turn_id": "t",
        "kind": {"type": "question", "text": "?", "schema": payload},
    }
    native_turn = object()
    native = type("NativeAgent", (), {})()
    native.requests = AsyncMock(return_value=json.dumps([request]))
    native.respond = AsyncMock(return_value=native_turn)
    agent = Agent(native)
    assert await agent.requests() == [request]
    response = {"type": "answer", "text": "yes", "data": payload}
    turn = await agent.respond(
        "r", response, AgentControlOptions(idempotency_key="key")
    )
    request_id, encoded, key = native.respond.await_args.args
    assert (request_id, key) == ("r", "key")
    assert json.loads(encoded) == response
    assert turn._native is native_turn
