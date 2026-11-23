"""Agents, turns, configuration, and events."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, TypedDict

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
    cursor: str | None
    active_turn_id: str | None
    queued_turn_ids: list[str]
    requests: list[AgentRequest]
    steering: list[AgentSteeringReceipt]


class AgentTurnState(TypedDict):
    id: str
    agent_id: str
    status: AgentTurnStatus
    cursor: str | None
    result: AgentResult | None
    requests: list[AgentRequest]
    steering: list[AgentSteeringReceipt]


class AgentCapabilities(TypedDict):
    operations: list[str]
    input_kinds: list[str]
    max_queued_turns: int | None
    max_pending_steering: int | None
    idempotency_retention_seconds: float | None


class AgentEvent(TypedDict):
    cursor: str | None
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


class AgentEventStream(AsyncIterator[AgentEvent]):
    """A live event stream whose pending read survives caller cancellation."""

    def __init__(self, opening):
        self._opening = asyncio.ensure_future(opening)
        self._pending = None
        self._reading = False
        self._closed = False
        self._stream = None
        self._close_task = None

    async def opened(self) -> None:
        self._stream = await asyncio.shield(self._opening)

    def __aiter__(self) -> AgentEventStream:
        return self

    async def __anext__(self) -> AgentEvent:
        if self._closed:
            raise StopAsyncIteration
        if self._reading:
            raise RuntimeError("concurrent event reads are not supported")
        self._reading = True
        try:
            if self._pending is None:
                try:
                    await self.opened()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self._closed = True
                    raise
                if self._closed:
                    raise StopAsyncIteration
                self._pending = asyncio.ensure_future(self._stream.next())
            try:
                value = await asyncio.shield(self._pending)
            except asyncio.CancelledError:
                raise
            except Exception:
                self._pending = None
                self._closed = True
                raise
            self._pending = None
            if value is None:
                self._closed = True
                raise StopAsyncIteration
            return json.loads(value)
        finally:
            self._reading = False

    async def aclose(self) -> None:
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        self._closed = True
        for future in (self._opening, self._pending):
            if future is not None and not future.done():
                future.cancel()
        await asyncio.gather(
            *(f for f in (self._opening, self._pending) if f is not None),
            return_exceptions=True,
        )
        if (
            self._stream is None
            and self._opening.done()
            and not self._opening.cancelled()
        ):
            if self._opening.exception() is not None:
                return
            self._stream = self._opening.result()
        if self._stream is not None:
            await self._stream.close()


class Agents:
    """Box-owned agent namespace."""

    def __init__(self, native=None, resolve=None):
        if native is None and resolve is None:
            raise TypeError("an agent namespace requires a box")
        self._native = native
        self._resolve = resolve

    def _handle(self):
        if self._resolve is not None:
            return self._resolve()._native
        return self._native

    async def create(
        self, agent: str, options: AgentCreateOptions | None = None
    ) -> Agent:
        options = options or AgentCreateOptions()
        native = await self._handle().create(
            agent,
            options.cwd,
            json.dumps(options.config or {}),
            options.idempotency_key,
        )
        return Agent(native)

    async def get(self, agent_id: str) -> Agent:
        return Agent(await self._handle().get(agent_id))


class Agent:
    """An agent conversation."""

    def __init__(self, native):
        self._native = native

    async def close(self, options: AgentControlOptions | None = None) -> None:
        await self._native.close(options.idempotency_key if options else None)

    async def send(
        self, text: str, options: AgentSendOptions | None = None
    ) -> AgentTurn:
        options = options or AgentSendOptions()
        return AgentTurn(
            await self._native.send(
                text, options.mode, json.dumps(options.data), options.idempotency_key
            )
        )

    async def get_turn(self, turn_id: str) -> AgentTurn:
        return AgentTurn(await self._native.get_turn(turn_id))

    def events(self, options: AgentEventsOptions | None = None) -> AgentEventStream:
        """Open the agent's events, after an opaque cursor where the adapter supports it."""
        return AgentEventStream(self._native.events(options.after if options else None))

    async def requests(self) -> list[AgentRequest]:
        return json.loads(await self._native.requests())

    async def respond(
        self,
        request_id: str,
        response: AgentResponse,
        options: AgentControlOptions | None = None,
    ) -> AgentTurn:
        return AgentTurn(
            await self._native.respond(
                request_id,
                json.dumps(response),
                options.idempotency_key if options else None,
            )
        )

    @property
    def state(self) -> AgentState:
        return json.loads(self._native.state)

    @property
    def config(self) -> AgentConfig:
        return json.loads(self._native.config)

    @property
    def capabilities(self) -> AgentCapabilities:
        return json.loads(self._native.capabilities)


class AgentTurn:
    """A submitted task. Steering retains this turn's identity."""

    def __init__(self, native):
        self._native = native

    async def wait(self, options: AgentWaitOptions | None = None) -> AgentResult:
        return json.loads(await self._native.wait(options.timeout if options else None))

    def events(self, options: AgentEventsOptions | None = None) -> AgentEventStream:
        return AgentEventStream(self._native.events(options.after if options else None))

    async def steer(
        self, text: str, options: AgentControlOptions | None = None
    ) -> AgentSteeringReceipt:
        return json.loads(
            await self._native.steer(text, options.idempotency_key if options else None)
        )

    async def interrupt(self, options: AgentControlOptions | None = None) -> None:
        await self._native.interrupt(options.idempotency_key if options else None)

    @property
    def state(self) -> AgentTurnState:
        return json.loads(self._native.state)
