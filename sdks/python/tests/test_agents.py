"""Check agent errors and namespace access without a native runtime."""

import pytest

import boxlite
from boxlite.agents import (
    AgentAnswer,
    AgentCreateOptions,
    AgentEventsOptions,
    AgentHandle,
    AgentSendOptions,
    AgentSession,
    AgentTurn,
    AgentWaitOptions,
)
from boxlite.errors import UnsupportedError
from boxlite.simplebox import SimpleBox
from boxlite.sync_api import SyncAgentHandle, SyncAgentSession, SyncAgentTurn

ASYNC_CALLS = [
    lambda: AgentHandle().create(
        "agent", AgentCreateOptions(config={"model": "model"})
    ),
    lambda: AgentHandle().get("session"),
    lambda: AgentSession().close(),
    lambda: AgentSession().send("task"),
    lambda: AgentSession().send(
        "task", AgentSendOptions(mode="reject", data={"key": 1})
    ),
    lambda: AgentSession().get_turn("turn"),
    lambda: AgentSession().requests(),
    lambda: AgentSession().respond(
        "request", {"type": "permission", "approved": False}
    ),
    lambda: AgentTurn().wait(AgentWaitOptions(timeout=1)),
    lambda: AgentTurn().steer("new direction"),
    lambda: AgentTurn().interrupt(),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("call", ASYNC_CALLS)
async def test_agents_async_operations_raise_unsupported(call):
    with pytest.raises(UnsupportedError, match="is not implemented"):
        await call()


@pytest.mark.parametrize("handle", [AgentSession(), AgentTurn()])
def test_agents_event_opening_fails_immediately(handle):
    with pytest.raises(UnsupportedError, match="events is not implemented"):
        handle.events(AgentEventsOptions(after="cursor"))


@pytest.mark.parametrize(
    "handle,field",
    [
        (AgentSession(), "state"),
        (AgentSession(), "config"),
        (AgentSession(), "capabilities"),
        (AgentTurn(), "state"),
        (SyncAgentSession(), "state"),
        (SyncAgentSession(), "config"),
        (SyncAgentSession(), "capabilities"),
        (SyncAgentTurn(), "state"),
    ],
)
def test_agents_getters_do_not_fabricate_state(handle, field):
    with pytest.raises(UnsupportedError, match=f"{field} is not implemented"):
        getattr(handle, field)


@pytest.mark.parametrize(
    "call",
    [
        lambda: SyncAgentHandle().create("agent"),
        lambda: SyncAgentHandle().get("session"),
        lambda: SyncAgentSession().close(),
        lambda: SyncAgentSession().send("task"),
        lambda: SyncAgentSession().get_turn("turn"),
        lambda: SyncAgentSession().events(),
        lambda: SyncAgentSession().requests(),
        lambda: SyncAgentSession().respond(
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
    assert isinstance(box.agents, AgentHandle)
    assert boxlite.AgentSession is AgentSession


@pytest.mark.asyncio
@pytest.mark.skipif(not hasattr(boxlite, "Box"), reason="native extension not built")
async def test_agents_native_box_namespace(tmp_path):
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(tmp_path)))
    box = await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
    with pytest.raises(UnsupportedError, match="agents.create is not implemented"):
        await box.agents.create("agent")


def test_agents_text_answer_data_is_optional():
    assert AgentAnswer.__required_keys__ == {"type", "text"}
    assert "data" in AgentAnswer.__optional_keys__
    assert boxlite.AgentCreateOptions is AgentCreateOptions
