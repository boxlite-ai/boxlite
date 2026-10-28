"""Synchronous agents and turns."""

from __future__ import annotations

from collections.abc import Iterator

from ..agents import (
    AgentCapabilities,
    AgentConfig,
    AgentControlOptions,
    AgentCreateOptions,
    AgentEvent,
    AgentEventsOptions,
    AgentRequest,
    AgentResponse,
    AgentResult,
    AgentSendOptions,
    AgentState,
    AgentSteeringReceipt,
    AgentTurnState,
    AgentWaitOptions,
    _not_implemented,
)


class SyncAgents:
    """Box-owned agent namespace."""

    def create(
        self, agent: str, options: AgentCreateOptions | None = None
    ) -> SyncAgent:
        _not_implemented("agents.create")

    def get(self, agent_id: str) -> SyncAgent:
        _not_implemented("agents.get")


class SyncAgent:
    """An agent conversation."""

    def close(self, options: AgentControlOptions | None = None) -> None:
        _not_implemented("agent.close")

    def send(self, text: str, options: AgentSendOptions | None = None) -> SyncAgentTurn:
        _not_implemented("agent.send")

    def get_turn(self, turn_id: str) -> SyncAgentTurn:
        _not_implemented("agent.get_turn")

    def events(self, options: AgentEventsOptions | None = None) -> Iterator[AgentEvent]:
        """Open the agent journal after an opaque cursor."""
        _not_implemented("agent.events")

    def requests(self) -> list[AgentRequest]:
        _not_implemented("agent.requests")

    def respond(
        self,
        request_id: str,
        response: AgentResponse,
        options: AgentControlOptions | None = None,
    ) -> SyncAgentTurn:
        _not_implemented("agent.respond")

    @property
    def state(self) -> AgentState:
        _not_implemented("agent.state")

    @property
    def config(self) -> AgentConfig:
        _not_implemented("agent.config")

    @property
    def capabilities(self) -> AgentCapabilities:
        _not_implemented("agent.capabilities")


class SyncAgentTurn:
    """A submitted task. Steering retains this turn's identity."""

    def wait(self, options: AgentWaitOptions | None = None) -> AgentResult:
        _not_implemented("turn.wait")

    def events(self, options: AgentEventsOptions | None = None) -> Iterator[AgentEvent]:
        _not_implemented("turn.events")

    def steer(
        self, text: str, options: AgentControlOptions | None = None
    ) -> AgentSteeringReceipt:
        _not_implemented("turn.steer")

    def interrupt(self, options: AgentControlOptions | None = None) -> None:
        _not_implemented("turn.interrupt")

    @property
    def state(self) -> AgentTurnState:
        _not_implemented("turn.state")
