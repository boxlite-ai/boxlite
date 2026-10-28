"""Check agent errors and namespace access across Python and native bindings."""

import pytest

import boxlite
from boxlite.agents import (
    Agent,
    AgentAnswer,
    AgentCreateOptions,
    AgentEventsOptions,
    Agents,
    AgentSendOptions,
    AgentTurn,
    AgentWaitOptions,
)
from boxlite.errors import UnsupportedError
from boxlite.simplebox import SimpleBox
from boxlite.sync_api import (
    SyncAgent,
    SyncAgents,
    SyncAgentTurn,
    SyncBox,
    SyncSimpleBox,
)

ASYNC_CALLS = [
    lambda: Agents().create("agent", AgentCreateOptions(config={"model": "model"})),
    lambda: Agents().get("agent"),
    lambda: Agent().close(),
    lambda: Agent().send("task"),
    lambda: Agent().send("task", AgentSendOptions(mode="reject", data={"key": 1})),
    lambda: Agent().get_turn("turn"),
    lambda: Agent().requests(),
    lambda: Agent().respond("request", {"type": "permission", "approved": False}),
    lambda: AgentTurn().wait(AgentWaitOptions(timeout=1)),
    lambda: AgentTurn().steer("new direction"),
    lambda: AgentTurn().interrupt(),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("call", ASYNC_CALLS)
async def test_agents_async_operations_raise_unsupported(call):
    with pytest.raises(UnsupportedError, match="is not implemented"):
        await call()


@pytest.mark.parametrize("handle", [Agent(), AgentTurn()])
def test_agents_event_opening_fails_immediately(handle):
    with pytest.raises(UnsupportedError, match="events is not implemented"):
        handle.events(AgentEventsOptions(after="cursor"))


@pytest.mark.parametrize(
    "handle,field",
    [
        (Agent(), "state"),
        (Agent(), "config"),
        (Agent(), "capabilities"),
        (AgentTurn(), "state"),
        (SyncAgent(), "state"),
        (SyncAgent(), "config"),
        (SyncAgent(), "capabilities"),
        (SyncAgentTurn(), "state"),
    ],
)
def test_agents_getters_do_not_fabricate_state(handle, field):
    with pytest.raises(UnsupportedError, match=f"{field} is not implemented"):
        getattr(handle, field)


@pytest.mark.parametrize(
    "call",
    [
        lambda: SyncAgents().create("agent"),
        lambda: SyncAgents().get("agent"),
        lambda: SyncAgent().close(),
        lambda: SyncAgent().send("task"),
        lambda: SyncAgent().get_turn("turn"),
        lambda: SyncAgent().events(),
        lambda: SyncAgent().requests(),
        lambda: SyncAgent().respond(
            "request", {"type": "answer", "text": "ok", "data": None}
        ),
        lambda: SyncAgentTurn().wait(),
        lambda: SyncAgentTurn().events(),
        lambda: SyncAgentTurn().steer("direction"),
        lambda: SyncAgentTurn().interrupt(),
    ],
)
def test_agents_sync_operations_raise_unsupported(call):
    with pytest.raises(UnsupportedError, match="is not implemented"):
        call()


def test_agents_simple_namespace_needs_no_runtime_initialization():
    # Only exercise the property: touching an uninitialized runtime would fail.
    box = object.__new__(SimpleBox)
    assert isinstance(box.agents, Agents)
    assert boxlite.Agent is Agent


@pytest.mark.parametrize("box_type", [SyncBox, SyncSimpleBox])
def test_agents_sync_namespace_needs_no_runtime_initialization(box_type):
    box = object.__new__(box_type)
    assert isinstance(box.agents, SyncAgents)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_agents_native_box_namespace(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    box = await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
    with pytest.raises(UnsupportedError, match="agents.create is not implemented"):
        await box.agents.create("agent")


def test_agents_text_answer_data_is_optional():
    assert AgentAnswer.__required_keys__ == {"type", "text"}
    assert "data" in AgentAnswer.__optional_keys__
    assert boxlite.AgentCreateOptions is AgentCreateOptions
