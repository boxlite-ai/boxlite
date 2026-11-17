import { describe, expect, test, vi } from "vitest";
import { wrapAgents, type NativeAgents } from "../lib/agents.js";

function setup() {
  let deliver!: (event: Record<string, unknown> | null) => void;
  const pending = new Promise<Record<string, unknown> | null>((resolve) => {
    deliver = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const stream = {
    opened: vi.fn().mockResolvedValue(undefined),
    nextEvent: vi.fn(() => {
      markStarted();
      return pending;
    }),
    close: vi.fn(async () => {
      deliver(null);
    }),
  };
  const native = {
    create: vi.fn(),
    get: async () => ({ events: () => stream }),
  } as unknown as NativeAgents;
  return { native, stream, deliver, started };
}

describe("agent event stream", () => {
  test("open failure reaches opened and the first read once", async () => {
    const stream = {
      opened: vi.fn().mockRejectedValue(new Error("open failed")),
      nextEvent: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const native = {
      create: vi.fn(),
      get: async () => ({ events: () => stream }),
    } as unknown as NativeAgents;
    const events = (await wrapAgents(native).get("agent")).events();
    await expect(events.opened()).rejects.toThrow("open failed");
    await expect(events.next()).rejects.toThrow("open failed");
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(stream.nextEvent).not.toHaveBeenCalled();
  });

  test("read errors follow earlier events once", async () => {
    const stream = {
      opened: vi.fn().mockResolvedValue(undefined),
      nextEvent: vi
        .fn()
        .mockResolvedValueOnce({ agent_id: "a", kind: "first", data: null })
        .mockRejectedValueOnce(new Error("read failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const native = {
      create: vi.fn(),
      get: async () => ({ events: () => stream }),
    } as unknown as NativeAgents;
    const events = (await wrapAgents(native).get("agent")).events();
    await expect(events.next()).resolves.toMatchObject({
      value: { kind: "first" },
    });
    await expect(events.next()).rejects.toThrow("read failed");
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("natural end stops iteration", async () => {
    const stream = {
      opened: vi.fn().mockResolvedValue(undefined),
      nextEvent: vi.fn().mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const native = {
      create: vi.fn(),
      get: async () => ({ events: () => stream }),
    } as unknown as NativeAgents;
    const events = (await wrapAgents(native).get("agent")).events();
    await expect(events.next()).resolves.toMatchObject({ done: true });
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(stream.nextEvent).toHaveBeenCalledOnce();
  });
  test("an aborted read preserves the event for the next caller", async () => {
    const { native, stream, deliver, started } = setup();
    const agent = await wrapAgents(native).get("agent");
    const events = agent.events();
    await events.opened();
    const controller = new AbortController();
    const first = events.read({ signal: controller.signal });
    await started;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    deliver({
      agent_id: "a",
      turn_id: "t",
      cursor: null,
      kind: "message",
      data: { turn_id: 1 },
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        agentId: "a",
        turnId: "t",
        kind: "message",
        data: { turn_id: 1 },
      },
    });
    expect(stream.nextEvent).toHaveBeenCalledOnce();
    await events.return();
  });

  test("closing resolves a pending read and closes once", async () => {
    const { native, stream, started } = setup();
    const agent = await wrapAgents(native).get("agent");
    const events = agent.events();
    const reading = events.next();
    await started;
    await Promise.all([events.return(), events.return()]);
    await expect(reading).resolves.toEqual({ done: true, value: undefined });
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("concurrent reads receive events in call order", async () => {
    let first!: (event: Record<string, unknown>) => void;
    let second!: (event: Record<string, unknown>) => void;
    const stream = {
      opened: vi.fn().mockResolvedValue(undefined),
      nextEvent: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              first = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              second = resolve;
            }),
        ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const native = {
      create: vi.fn(),
      get: async () => ({ events: () => stream }),
    } as unknown as NativeAgents;
    const events = (await wrapAgents(native).get("agent")).events();
    const one = events.next();
    const two = events.next();
    await vi.waitFor(() => expect(stream.nextEvent).toHaveBeenCalledTimes(1));
    first({ agent_id: "a", kind: "first", data: null });
    await expect(one).resolves.toMatchObject({ value: { kind: "first" } });
    await vi.waitFor(() => expect(stream.nextEvent).toHaveBeenCalledTimes(2));
    second({ agent_id: "a", kind: "second", data: null });
    await expect(two).resolves.toMatchObject({ value: { kind: "second" } });
    await events.return();
  });
});

test("maps nested turn records without renaming free JSON", async () => {
  const data = { turn_id: "inside", value: null };
  const native = {
    create: vi.fn(),
    get: async () => ({
      getTurn: async () => ({
        state: {
          id: "turn",
          agent_id: "agent",
          status: "completed",
          cursor: null,
          result: {
            turn_id: "turn",
            status: "completed",
            outcome: null,
            text: null,
            data,
            artifacts: [],
            usage: null,
            error: null,
          },
          requests: [
            {
              id: "request",
              turn_id: "turn",
              kind: { type: "question", text: "continue?", schema: data },
            },
          ],
          steering: [{ id: "steer", turn_id: "turn", status: "accepted" }],
        },
      }),
    }),
  } as unknown as NativeAgents;
  const turn = await (await wrapAgents(native).get("agent")).getTurn("turn");
  expect(turn.state).toEqual({
    id: "turn",
    agentId: "agent",
    status: "completed",
    result: { turnId: "turn", status: "completed", data, artifacts: [] },
    requests: [
      {
        id: "request",
        turnId: "turn",
        kind: { type: "question", text: "continue?", schema: data },
      },
    ],
    steering: [{ id: "steer", turnId: "turn", status: "accepted" }],
  });
});

test("forwards requests and responses without changing free JSON", async () => {
  const data = { turn_id: "inside", value: null };
  const respond = vi.fn().mockResolvedValue({});
  const native = {
    create: vi.fn(),
    get: async () => ({
      requests: async () => [
        {
          id: "r",
          turn_id: "t",
          kind: { type: "question", text: "?", schema: data },
        },
      ],
      respond,
    }),
  } as unknown as NativeAgents;
  const agent = await wrapAgents(native).get("agent");
  expect(await agent.requests()).toEqual([
    {
      id: "r",
      turnId: "t",
      kind: { type: "question", text: "?", schema: data },
    },
  ]);
  const response = { type: "answer" as const, text: "yes", data };
  await agent.respond("r", response, { idempotencyKey: "key" });
  expect(respond).toHaveBeenCalledWith("r", response, {
    idempotencyKey: "key",
  });
});
