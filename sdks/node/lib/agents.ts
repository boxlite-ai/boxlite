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
  cursor: string;
  activeTurnId?: string;
  queuedTurnIds: string[];
  requests: AgentRequest[];
  steering: AgentSteeringReceipt[];
}
export interface AgentTurnState {
  id: string;
  agentId: string;
  status: AgentTurnStatus;
  cursor: string;
  result?: AgentResult;
  requests: AgentRequest[];
  steering: AgentSteeringReceipt[];
}
export interface AgentCapabilities {
  operations: string[];
  inputKinds: string[];
  maxQueuedTurns: number;
  maxPendingSteering: number;
  idempotencyRetentionSeconds: number;
}
export interface AgentEvent {
  cursor: string;
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
  /** Open the agent journal after an opaque cursor. */
  events(options?: AgentEventsOptions): AsyncIterable<AgentEvent>;
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
  events(options?: AgentEventsOptions): AsyncIterable<AgentEvent>;
  steer(
    text: string,
    options?: AgentControlOptions,
  ): Promise<AgentSteeringReceipt>;
  interrupt(options?: AgentControlOptions): Promise<void>;
  readonly state: AgentTurnState;
}
