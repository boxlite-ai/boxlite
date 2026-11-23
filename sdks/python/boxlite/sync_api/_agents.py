"""Synchronous wrappers for the agent API."""

from __future__ import annotations

from collections.abc import Iterator

from ..agents import (
    AgentControlOptions,
    AgentCreateOptions,
    AgentEventsOptions,
    AgentSendOptions,
    AgentWaitOptions,
)
from ._sync_base import SyncBase


class SyncAgentEventStream(Iterator):
    def __init__(self, context, stream):
        self._stream = stream
        self._sync = SyncBase(stream, context.loop, context.dispatcher_fiber)._sync

    def opened(self):
        self._sync(self._stream.opened())

    def close(self):
        self._sync(self._stream.aclose())

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return self._sync(self._stream.__anext__())
        except StopAsyncIteration:
            raise StopIteration from None


class SyncAgents:
    """Box-owned agent namespace."""

    def __init__(self, resolve):
        self._resolve = resolve

    def _box(self):
        return self._resolve()

    def create(
        self, agent: str, options: AgentCreateOptions | None = None
    ) -> SyncAgent:
        box = self._box()
        return SyncAgent(
            box._runtime, box._sync(box._box.agents.create(agent, options))
        )

    def get(self, agent_id: str) -> SyncAgent:
        box = self._box()
        return SyncAgent(box._runtime, box._sync(box._box.agents.get(agent_id)))


class SyncAgent:
    """An agent conversation."""

    def __init__(self, context, agent):
        self._context = context
        self._agent = agent
        self._sync = (
            SyncBase(agent, context.loop, context.dispatcher_fiber)._sync
            if context
            else None
        )

    def close(self, options: AgentControlOptions | None = None):
        return self._sync(self._agent.close(options))

    def send(self, text: str, options: AgentSendOptions | None = None) -> SyncAgentTurn:
        return SyncAgentTurn(self._context, self._sync(self._agent.send(text, options)))

    def get_turn(self, turn_id: str) -> SyncAgentTurn:
        return SyncAgentTurn(self._context, self._sync(self._agent.get_turn(turn_id)))

    def events(self, options: AgentEventsOptions | None = None) -> SyncAgentEventStream:
        async def open_stream():
            return self._agent.events(options)

        return SyncAgentEventStream(self._context, self._sync(open_stream()))

    def requests(self):
        return self._sync(self._agent.requests())

    def respond(self, request_id, response, options: AgentControlOptions | None = None):
        return SyncAgentTurn(
            self._context,
            self._sync(self._agent.respond(request_id, response, options)),
        )

    @property
    def state(self):
        return self._agent.state

    @property
    def config(self):
        return self._agent.config

    @property
    def capabilities(self):
        return self._agent.capabilities


class SyncAgentTurn:
    """A submitted task."""

    def __init__(self, context, turn):
        self._context = context
        self._turn = turn
        self._sync = (
            SyncBase(turn, context.loop, context.dispatcher_fiber)._sync
            if context
            else None
        )

    def wait(self, options: AgentWaitOptions | None = None):
        return self._sync(self._turn.wait(options))

    def events(self, options: AgentEventsOptions | None = None) -> SyncAgentEventStream:
        async def open_stream():
            return self._turn.events(options)

        return SyncAgentEventStream(self._context, self._sync(open_stream()))

    def steer(self, text: str, options: AgentControlOptions | None = None):
        return self._sync(self._turn.steer(text, options))

    def interrupt(self, options: AgentControlOptions | None = None):
        return self._sync(self._turn.interrupt(options))

    @property
    def state(self):
        return self._turn.state
