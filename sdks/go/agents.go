package boxlite

import (
	"context"
	"encoding/json"
	"time"
)

// AgentConfig contains initial configuration; tools/MCP name Box-managed resources.
type AgentConfig struct {
	Model        string
	Reasoning    string
	Instructions string
	Tools        []string
	MCP          []string
	Permissions  json.RawMessage
	Limits       json.RawMessage
	OutputSchema json.RawMessage
}

type AgentCreateOptions struct {
	Cwd            string
	Config         AgentConfig
	IdempotencyKey string
}

type AgentSendMode string

const (
	AgentSendQueue  AgentSendMode = "queue"
	AgentSendReject AgentSendMode = "reject"
)

// AgentSendOptions.Mode defaults to queue when empty.
type AgentSendOptions struct {
	Mode           AgentSendMode
	Data           json.RawMessage
	IdempotencyKey string
}

// AgentWaitOptions groups the optional deadline; nil means no deadline.
type AgentWaitOptions struct{ Timeout *time.Duration }

// AgentEventsOptions groups the optional journal cursor.
type AgentEventsOptions struct{ After string }

type AgentControlOptions struct{ IdempotencyKey string }

type AgentStatus string

const (
	AgentReady   AgentStatus = "ready"
	AgentBusy    AgentStatus = "busy"
	AgentClosing AgentStatus = "closing"
	AgentClosed  AgentStatus = "closed"
	AgentUnknown AgentStatus = "unknown"
)

type AgentTurnStatus string

const (
	AgentTurnQueued       AgentTurnStatus = "queued"
	AgentTurnRunning      AgentTurnStatus = "running"
	AgentTurnWaitingInput AgentTurnStatus = "waiting_input"
	AgentTurnInterrupting AgentTurnStatus = "interrupting"
	AgentTurnCompleted    AgentTurnStatus = "completed"
	AgentTurnCancelled    AgentTurnStatus = "cancelled"
	AgentTurnFailed       AgentTurnStatus = "failed"
	AgentTurnUnknown      AgentTurnStatus = "unknown"
)

// AgentRequestKind distinguishes questions from permission requests.
type AgentRequestKind interface{ agentRequestKind() }
type AgentQuestion struct {
	Text   string
	Schema json.RawMessage
}

func (AgentQuestion) agentRequestKind() {}

type AgentPermission struct {
	Tool      string
	Arguments json.RawMessage
}

func (AgentPermission) agentRequestKind() {}

type AgentRequest struct {
	ID     string
	TurnID string
	Kind   AgentRequestKind
}

// AgentResponse cannot accidentally turn an ordinary text answer into permission.
type AgentResponse interface{ agentResponse() }
type AgentAnswer struct {
	Text string
	Data json.RawMessage
}

func (AgentAnswer) agentResponse() {}

type AgentPermissionResponse struct{ Approved bool }

func (AgentPermissionResponse) agentResponse() {}

type AgentSteeringStatus string

const (
	AgentSteeringAccepted AgentSteeringStatus = "accepted"
	AgentSteeringApplied  AgentSteeringStatus = "applied"
	AgentSteeringUnused   AgentSteeringStatus = "unused"
	AgentSteeringUnknown  AgentSteeringStatus = "unknown"
)

type AgentSteeringReceipt struct {
	ID     string
	TurnID string
	Status AgentSteeringStatus
}

type AgentOutcome string

const (
	AgentOutcomeAnswer   AgentOutcome = "answer"
	AgentOutcomeQuestion AgentOutcome = "question"
)

type AgentResult struct {
	TurnID    string
	Status    AgentTurnStatus
	Outcome   AgentOutcome
	Text      string
	Data      json.RawMessage
	Artifacts []string
	Usage     json.RawMessage
	Error     string
}
type AgentState struct {
	ID            string
	Status        AgentStatus
	Cursor        string
	ActiveTurnID  string
	QueuedTurnIDs []string
	Requests      []AgentRequest
	Steering      []AgentSteeringReceipt
}
type AgentTurnState struct {
	ID       string
	AgentID  string
	Status   AgentTurnStatus
	Cursor   string
	Result   *AgentResult
	Requests []AgentRequest
	Steering []AgentSteeringReceipt
}
type AgentCapabilities struct {
	Operations           []string
	InputKinds           []string
	MaxQueuedTurns       uint
	MaxPendingSteering   uint
	IdempotencyRetention time.Duration
}
type AgentEvent struct {
	Cursor  string
	AgentID string
	TurnID  string
	Kind    string
	Data    json.RawMessage
}

// AgentEventStream reads the agent journal.
type AgentEventStream interface {
	Next(context.Context) (*AgentEvent, error)
	Close() error
}

// Agents, Agent and AgentTurn address agent conversations and work.
type Agents struct{}
type Agent struct{}
type AgentTurn struct{}

// Agents obtains the namespace without starting the Box.
func (b *Box) Agents() *Agents { return &Agents{} }

func agentNotImplemented(operation string) error {
	return &Error{Code: ErrUnsupported, Message: operation + " is not implemented"}
}

func (a *Agents) Create(ctx context.Context, agent string, options AgentCreateOptions) (*Agent, error) {
	return nil, agentNotImplemented("agents.create")
}
func (a *Agents) Get(ctx context.Context, agentID string) (*Agent, error) {
	return nil, agentNotImplemented("agents.get")
}
func (s *Agent) Close(ctx context.Context, options AgentControlOptions) error {
	return agentNotImplemented("agent.close")
}
func (s *Agent) Send(ctx context.Context, text string, options AgentSendOptions) (*AgentTurn, error) {
	return nil, agentNotImplemented("agent.send")
}
func (s *Agent) GetTurn(ctx context.Context, turnID string) (*AgentTurn, error) {
	return nil, agentNotImplemented("agent.get_turn")
}
func (s *Agent) Events(ctx context.Context, options AgentEventsOptions) (AgentEventStream, error) {
	return nil, agentNotImplemented("agent.events")
}
func (s *Agent) Requests(ctx context.Context) ([]AgentRequest, error) {
	return nil, agentNotImplemented("agent.requests")
}
func (s *Agent) Respond(ctx context.Context, requestID string, response AgentResponse, options AgentControlOptions) (*AgentTurn, error) {
	return nil, agentNotImplemented("agent.respond")
}
func (s *Agent) State() (*AgentState, error) {
	return nil, agentNotImplemented("agent.state")
}
func (s *Agent) Config() (*AgentConfig, error) {
	return nil, agentNotImplemented("agent.config")
}
func (s *Agent) Capabilities() (*AgentCapabilities, error) {
	return nil, agentNotImplemented("agent.capabilities")
}
func (t *AgentTurn) Wait(ctx context.Context, options AgentWaitOptions) (*AgentResult, error) {
	return nil, agentNotImplemented("turn.wait")
}
func (t *AgentTurn) Events(ctx context.Context, options AgentEventsOptions) (AgentEventStream, error) {
	return nil, agentNotImplemented("turn.events")
}
func (t *AgentTurn) Steer(ctx context.Context, text string, options AgentControlOptions) (*AgentSteeringReceipt, error) {
	return nil, agentNotImplemented("turn.steer")
}
func (t *AgentTurn) Interrupt(ctx context.Context, options AgentControlOptions) error {
	return agentNotImplemented("turn.interrupt")
}
func (t *AgentTurn) State() (*AgentTurnState, error) {
	return nil, agentNotImplemented("turn.state")
}
