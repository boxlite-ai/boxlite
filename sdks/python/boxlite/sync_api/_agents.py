"""Synchronous P0 declarations; all operations are unimplemented."""

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
    AgentSessionState,
    AgentSteeringReceipt,
    AgentTurnState,
    AgentWaitOptions,
    _not_implemented,
)


class SyncAgentHandle:
    """Inert Box-owned namespace; no session or process is created."""

    def create(
        self, agent: str, options: AgentCreateOptions | None = None
    ) -> SyncAgentSession:
        _not_implemented("agents.create")

    def get(self, session_id: str) -> SyncAgentSession:
        _not_implemented("agents.get")


class SyncAgentSession:
    """P0 conversation declarations; all methods and properties are unavailable."""

    def close(self, options: AgentControlOptions | None = None) -> None:
        _not_implemented("session.close")

    def send(self, text: str, options: AgentSendOptions | None = None) -> SyncAgentTurn:
        _not_implemented("session.send")

    def get_turn(self, turn_id: str) -> SyncAgentTurn:
        _not_implemented("session.get_turn")

    def events(self, options: AgentEventsOptions | None = None) -> Iterator[AgentEvent]:
        """Fail on opening, rather than returning an empty successful stream."""
        _not_implemented("session.events")

    def requests(self) -> list[AgentRequest]:
        _not_implemented("session.requests")

    def respond(
        self,
        request_id: str,
        response: AgentResponse,
        options: AgentControlOptions | None = None,
    ) -> SyncAgentTurn:
        _not_implemented("session.respond")

    @property
    def state(self) -> AgentSessionState:
        _not_implemented("session.state")

    @property
    def config(self) -> AgentConfig:
        _not_implemented("session.config")

    @property
    def capabilities(self) -> AgentCapabilities:
        _not_implemented("session.capabilities")


class SyncAgentTurn:
    """P0 task declarations. Steering retains this turn's identity."""

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
