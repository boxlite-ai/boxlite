/** Agents, turns, configuration, and events. */
export type AgentJson =
  null | boolean | number | string | AgentJson[] | { [key: string]: AgentJson };
export interface AgentConfig {
  model?: string;
  reasoning?: string;
  instructions?: string;
  tools?: string[];
  mcp?: string[];
  permissions?: AgentJson;
  limits?: AgentJson;
  outputSchema?: AgentJson;
}
export interface AgentWaitOptions {
  timeoutSeconds?: number;
}
export interface AgentEventsOptions {
  after?: string;
}
export interface AgentControlOptions {
  idempotencyKey?: string;
}
export interface AgentCreateOptions extends AgentControlOptions {
  cwd?: string;
  config?: AgentConfig;
}
export interface AgentSendOptions extends AgentControlOptions {
  /** Defaults to queue. */
  mode?: "queue" | "reject";
  data?: AgentJson;
}
export type AgentStatus = "ready" | "busy" | "closing" | "closed" | "unknown";
export type AgentTurnStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "interrupting"
  | "completed"
  | "cancelled"
  | "failed"
  | "unknown";
export interface AgentRequest {
  id: string;
  turnId: string;
  kind:
    | { type: "question"; text: string; schema?: AgentJson }
    | { type: "permission"; tool: string; arguments: AgentJson };
}
export type AgentResponse =
  | { type: "answer"; text: string; data?: AgentJson }
  | { type: "permission"; approved: boolean };
export interface AgentSteeringReceipt {
  id: string;
  turnId: string;
  status: "accepted" | "applied" | "unused" | "unknown";
}
export interface AgentResult {
  turnId: string;
  status: AgentTurnStatus;
  outcome?: "answer" | "question";
  text?: string;
  data?: AgentJson;
  artifacts: string[];
  usage?: AgentJson;
  error?: string;
}
export interface AgentState {
  id: string;
  status: AgentStatus;
  cursor?: string;
  activeTurnId?: string;
  queuedTurnIds: string[];
  requests: AgentRequest[];
  steering: AgentSteeringReceipt[];
}
export interface AgentTurnState {
  id: string;
  agentId: string;
  status: AgentTurnStatus;
  cursor?: string;
  result?: AgentResult;
  requests: AgentRequest[];
  steering: AgentSteeringReceipt[];
}
export interface AgentCapabilities {
  operations: string[];
  inputKinds: string[];
  maxQueuedTurns?: number;
  maxPendingSteering?: number;
  idempotencyRetentionSeconds?: number;
}
export interface AgentEvent {
  cursor?: string;
  agentId: string;
  turnId?: string;
  kind: string;
  data: AgentJson;
}
export interface Agents {
  create(agent: string, options?: AgentCreateOptions): Promise<Agent>;
  get(agentId: string): Promise<Agent>;
}
export interface Agent {
  close(options?: AgentControlOptions): Promise<void>;
  send(text: string, options?: AgentSendOptions): Promise<AgentTurn>;
  getTurn(turnId: string): Promise<AgentTurn>;
  /** Open the agent's events, after an opaque cursor where the adapter supports it. */
  events(options?: AgentEventsOptions): AgentEventStream;
  requests(): Promise<AgentRequest[]>;
  respond(
    requestId: string,
    response: AgentResponse,
    options?: AgentControlOptions,
  ): Promise<AgentTurn>;
  readonly state: AgentState;
  readonly config: AgentConfig;
  readonly capabilities: AgentCapabilities;
}
export interface AgentTurn {
  wait(options?: AgentWaitOptions): Promise<AgentResult>;
  events(options?: AgentEventsOptions): AgentEventStream;
  steer(
    text: string,
    options?: AgentControlOptions,
  ): Promise<AgentSteeringReceipt>;
  interrupt(options?: AgentControlOptions): Promise<void>;
  readonly state: AgentTurnState;
}

/** A live stream that retains an aborted read for the next caller. */
export interface AgentEventStream extends AsyncIterableIterator<AgentEvent> {
  opened(): Promise<void>;
  read(options?: { signal?: AbortSignal }): Promise<IteratorResult<AgentEvent>>;
  return(): Promise<IteratorResult<AgentEvent>>;
}

type RecordValue = Record<string, unknown>;
interface NativeStream {
  opened(): Promise<void>;
  nextEvent(): Promise<RecordValue | null>;
  close(): Promise<void>;
}
interface NativeTurn {
  wait(options?: AgentWaitOptions): Promise<RecordValue>;
  events(options?: AgentEventsOptions): NativeStream;
  steer(text: string, options?: AgentControlOptions): Promise<RecordValue>;
  interrupt(options?: AgentControlOptions): Promise<void>;
  readonly state: RecordValue;
}
interface NativeAgent {
  close(options?: AgentControlOptions): Promise<void>;
  send(text: string, options?: AgentSendOptions): Promise<NativeTurn>;
  getTurn(id: string): Promise<NativeTurn>;
  events(options?: AgentEventsOptions): NativeStream;
  requests(): Promise<RecordValue[]>;
  respond(
    id: string,
    response: AgentResponse,
    options?: AgentControlOptions,
  ): Promise<NativeTurn>;
  readonly state: RecordValue;
  readonly config: RecordValue;
  readonly capabilities: RecordValue;
}
export interface NativeAgents {
  create(agent: string, options?: RecordValue): Promise<NativeAgent>;
  get(id: string): Promise<NativeAgent>;
}

function fields(
  record: RecordValue,
  names: Record<string, string>,
  optional: string[] = [],
): RecordValue {
  const output: RecordValue = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null && optional.includes(key)) continue;
    output[names[key] ?? key] = value;
  }
  return output;
}
function request(record: RecordValue): AgentRequest {
  const result = fields(record, { turn_id: "turnId" });
  result.kind = fields(result.kind as RecordValue, {}, ["schema"]);
  return result as unknown as AgentRequest;
}
function receipt(record: RecordValue): AgentSteeringReceipt {
  return fields(record, {
    turn_id: "turnId",
  }) as unknown as AgentSteeringReceipt;
}
function result(record: RecordValue): AgentResult {
  return fields(record, { turn_id: "turnId" }, [
    "outcome",
    "text",
    "data",
    "usage",
    "error",
  ]) as unknown as AgentResult;
}
function turnState(record: RecordValue): AgentTurnState {
  const mapped = fields(record, { agent_id: "agentId" }, ["cursor", "result"]);
  if (mapped.result) mapped.result = result(mapped.result as RecordValue);
  mapped.requests = (mapped.requests as RecordValue[]).map(request);
  mapped.steering = (mapped.steering as RecordValue[]).map(receipt);
  return mapped as unknown as AgentTurnState;
}
function agentState(record: RecordValue): AgentState {
  const mapped = fields(
    record,
    { active_turn_id: "activeTurnId", queued_turn_ids: "queuedTurnIds" },
    ["cursor", "active_turn_id"],
  );
  mapped.requests = (mapped.requests as RecordValue[]).map(request);
  mapped.steering = (mapped.steering as RecordValue[]).map(receipt);
  return mapped as unknown as AgentState;
}
function event(record: RecordValue): AgentEvent {
  return fields(record, { agent_id: "agentId", turn_id: "turnId" }, [
    "cursor",
    "turn_id",
  ]) as unknown as AgentEvent;
}
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  canAbort: () => boolean = () => true,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (canAbort()) reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
class EventStream implements AgentEventStream {
  private pending?: Promise<RecordValue | null>;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly native: NativeStream) {}
  opened(): Promise<void> {
    return this.native.opened();
  }
  [Symbol.asyncIterator](): AgentEventStream {
    return this;
  }
  next(): Promise<IteratorResult<AgentEvent>> {
    return this.read();
  }
  read(options?: {
    signal?: AbortSignal;
  }): Promise<IteratorResult<AgentEvent>> {
    const signal = options?.signal;
    let delivered = false;
    const operation = this.tail.then(
      async (): Promise<IteratorResult<AgentEvent>> => {
        if (signal?.aborted) throw abortError();
        if (this.closed) return { done: true, value: undefined };
        try {
          await abortable(this.opened(), signal);
          if (this.closed) return { done: true, value: undefined };
          this.pending ??= this.native.nextEvent();
          const item = await abortable(this.pending, signal);
          if (signal?.aborted) throw abortError();
          this.pending = undefined;
          if (item === null) {
            this.closed = true;
            delivered = true;
            return { done: true, value: undefined };
          }
          const result = { done: false as const, value: event(item) };
          delivered = true;
          return result;
        } catch (error) {
          if (!signal?.aborted) {
            this.pending = undefined;
            this.closed = true;
            await this.native.close();
          }
          throw error;
        }
      },
    );
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return abortable(operation, signal, () => !delivered);
  }
  async return(): Promise<IteratorResult<AgentEvent>> {
    this.closed = true;
    this.closing ??= this.native.close();
    await this.closing;
    return { done: true, value: undefined };
  }
}
class WrappedTurn implements AgentTurn {
  constructor(private readonly native: NativeTurn) {}
  async wait(options?: AgentWaitOptions): Promise<AgentResult> {
    return result(await this.native.wait(options));
  }
  events(options?: AgentEventsOptions): AgentEventStream {
    return new EventStream(this.native.events(options));
  }
  async steer(
    text: string,
    options?: AgentControlOptions,
  ): Promise<AgentSteeringReceipt> {
    return receipt(await this.native.steer(text, options));
  }
  interrupt(options?: AgentControlOptions): Promise<void> {
    return this.native.interrupt(options);
  }
  get state(): AgentTurnState {
    return turnState(this.native.state);
  }
}
class WrappedAgent implements Agent {
  constructor(private readonly native: NativeAgent) {}
  close(options?: AgentControlOptions): Promise<void> {
    return this.native.close(options);
  }
  async send(text: string, options?: AgentSendOptions): Promise<AgentTurn> {
    return new WrappedTurn(await this.native.send(text, options));
  }
  async getTurn(id: string): Promise<AgentTurn> {
    return new WrappedTurn(await this.native.getTurn(id));
  }
  events(options?: AgentEventsOptions): AgentEventStream {
    return new EventStream(this.native.events(options));
  }
  async requests(): Promise<AgentRequest[]> {
    return (await this.native.requests()).map(request);
  }
  async respond(
    id: string,
    response: AgentResponse,
    options?: AgentControlOptions,
  ): Promise<AgentTurn> {
    return new WrappedTurn(await this.native.respond(id, response, options));
  }
  get state(): AgentState {
    return agentState(this.native.state);
  }
  get config(): AgentConfig {
    return fields(this.native.config, {
      output_schema: "outputSchema",
    }) as AgentConfig;
  }
  get capabilities(): AgentCapabilities {
    return fields(
      this.native.capabilities,
      {
        input_kinds: "inputKinds",
        max_queued_turns: "maxQueuedTurns",
        max_pending_steering: "maxPendingSteering",
        idempotency_retention_seconds: "idempotencyRetentionSeconds",
      },
      [
        "max_queued_turns",
        "max_pending_steering",
        "idempotency_retention_seconds",
      ],
    ) as unknown as AgentCapabilities;
  }
}
export function wrapAgents(native: NativeAgents): Agents {
  const create = native.create.bind(native);
  const get = native.get.bind(native);
  Object.defineProperties(native, {
    create: {
      configurable: true,
      value: async (agent: string, options?: AgentCreateOptions) => {
        const input = options ? ({ ...options } as RecordValue) : undefined;
        if (input && options?.config)
          input.config = fields(options.config as RecordValue, {
            outputSchema: "output_schema",
          });
        return new WrappedAgent(await create(agent, input));
      },
    },
    get: {
      configurable: true,
      value: async (id: string) => new WrappedAgent(await get(id)),
    },
  });
  return native as unknown as Agents;
}
