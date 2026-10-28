"""Agents, turns, configuration, and events."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, NoReturn, TypedDict

from .errors import UnsupportedError

JsonValue = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
AgentStatus = Literal["ready", "busy", "closing", "closed", "unknown"]
AgentTurnStatus = Literal[
    "queued",
    "running",
    "waiting_input",
    "interrupting",
    "completed",
    "cancelled",
    "failed",
    "unknown",
]


class AgentConfig(TypedDict, total=False):
    model: str
    reasoning: str
    instructions: str
    tools: list[str]
    mcp: list[str]
    permissions: JsonValue
    limits: JsonValue
    output_schema: JsonValue


class _QuestionOptions(TypedDict, total=False):
    schema: JsonValue


class AgentQuestion(_QuestionOptions):
    type: Literal["question"]
    text: str


class AgentPermission(TypedDict):
    type: Literal["permission"]
    tool: str
    arguments: JsonValue


class AgentRequest(TypedDict):
    id: str
    turn_id: str
    kind: AgentQuestion | AgentPermission


class _AnswerOptions(TypedDict, total=False):
    data: JsonValue


class AgentAnswer(_AnswerOptions):
    type: Literal["answer"]
    text: str


class AgentPermissionResponse(TypedDict):
    type: Literal["permission"]
    approved: bool


AgentResponse = AgentAnswer | AgentPermissionResponse


class AgentSteeringReceipt(TypedDict):
    id: str
    turn_id: str
    status: Literal["accepted", "applied", "unused", "unknown"]


class AgentResult(TypedDict):
    turn_id: str
    status: AgentTurnStatus
    outcome: Literal["answer", "question"] | None
    text: str | None
    data: JsonValue
    artifacts: list[str]
    usage: JsonValue
    error: str | None


class AgentState(TypedDict):
    id: str
    status: AgentStatus
    cursor: str
    active_turn_id: str | None
    queued_turn_ids: list[str]
    requests: list[AgentRequest]
    steering: list[AgentSteeringReceipt]


class AgentTurnState(TypedDict):
    id: str
    agent_id: str
    status: AgentTurnStatus
    cursor: str
    result: AgentResult | None
    requests: list[AgentRequest]
    steering: list[AgentSteeringReceipt]


class AgentCapabilities(TypedDict):
    operations: list[str]
    input_kinds: list[str]
    max_queued_turns: int
    max_pending_steering: int
    idempotency_retention_seconds: float


class AgentEvent(TypedDict):
    cursor: str
    agent_id: str
    turn_id: str | None
    kind: str
    data: JsonValue


@dataclass(frozen=True, kw_only=True)
class AgentControlOptions:
    idempotency_key: str | None = None


@dataclass(frozen=True, kw_only=True)
class AgentCreateOptions(AgentControlOptions):
    cwd: str | None = None
    config: AgentConfig | None = None


@dataclass(frozen=True, kw_only=True)
class AgentSendOptions(AgentControlOptions):
    mode: Literal["queue", "reject"] = "queue"
    data: JsonValue = None


@dataclass(frozen=True, kw_only=True)
class AgentWaitOptions:
    timeout: float | None = None


@dataclass(frozen=True, kw_only=True)
class AgentEventsOptions:
    after: str | None = None


def _not_implemented(operation: str) -> NoReturn:
    raise UnsupportedError(f"{operation} is not implemented")


class Agents:
    """Box-owned agent namespace."""

    async def create(
        self, agent: str, options: AgentCreateOptions | None = None
    ) -> Agent:
        _not_implemented("agents.create")

    async def get(self, agent_id: str) -> Agent:
        _not_implemented("agents.get")


class Agent:
    """An agent conversation."""

    async def close(self, options: AgentControlOptions | None = None) -> None:
        _not_implemented("agent.close")

    async def send(
        self, text: str, options: AgentSendOptions | None = None
    ) -> AgentTurn:
        _not_implemented("agent.send")

    async def get_turn(self, turn_id: str) -> AgentTurn:
        _not_implemented("agent.get_turn")

    def events(
        self, options: AgentEventsOptions | None = None
    ) -> AsyncIterator[AgentEvent]:
        """Open the agent journal after an opaque cursor."""
        _not_implemented("agent.events")

    async def requests(self) -> list[AgentRequest]:
        _not_implemented("agent.requests")

    async def respond(
        self,
        request_id: str,
        response: AgentResponse,
        options: AgentControlOptions | None = None,
    ) -> AgentTurn:
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


class AgentTurn:
    """A submitted task. Steering retains this turn's identity."""

    async def wait(self, options: AgentWaitOptions | None = None) -> AgentResult:
        _not_implemented("turn.wait")

    def events(
        self, options: AgentEventsOptions | None = None
    ) -> AsyncIterator[AgentEvent]:
        _not_implemented("turn.events")

    async def steer(
        self, text: str, options: AgentControlOptions | None = None
    ) -> AgentSteeringReceipt:
        _not_implemented("turn.steer")

    async def interrupt(self, options: AgentControlOptions | None = None) -> None:
        _not_implemented("turn.interrupt")

    @property
    def state(self) -> AgentTurnState:
        _not_implemented("turn.state")
