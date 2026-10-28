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

type AgentSessionStatus string

const (
	AgentSessionReady   AgentSessionStatus = "ready"
	AgentSessionBusy    AgentSessionStatus = "busy"
	AgentSessionClosing AgentSessionStatus = "closing"
	AgentSessionClosed  AgentSessionStatus = "closed"
	AgentSessionUnknown AgentSessionStatus = "unknown"
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
type AgentSessionState struct {
	ID            string
	Status        AgentSessionStatus
	Cursor        string
	ActiveTurnID  string
	QueuedTurnIDs []string
	Requests      []AgentRequest
	Steering      []AgentSteeringReceipt
}
type AgentTurnState struct {
	ID        string
	SessionID string
	Status    AgentTurnStatus
	Cursor    string
	Result    *AgentResult
	Requests  []AgentRequest
	Steering  []AgentSteeringReceipt
}
type AgentCapabilities struct {
	Operations           []string
	InputKinds           []string
	MaxQueuedTurns       uint
	MaxPendingSteering   uint
	IdempotencyRetention time.Duration
}
type AgentEvent struct {
	Cursor    string
	SessionID string
	TurnID    string
	Kind      string
	Data      json.RawMessage
}

// AgentEventStream reads the agent journal.
type AgentEventStream interface {
	Next(context.Context) (*AgentEvent, error)
	Close() error
}

// AgentHandle, AgentSession and AgentTurn address agent conversations and work.
type AgentHandle struct{}
type AgentSession struct{}
type AgentTurn struct{}

// Agents obtains the namespace without starting the Box.
func (b *Box) Agents() *AgentHandle { return &AgentHandle{} }

func agentNotImplemented(operation string) error {
	return &Error{Code: ErrUnsupported, Message: operation + " is not implemented"}
}

func (a *AgentHandle) Create(ctx context.Context, agent string, options AgentCreateOptions) (*AgentSession, error) {
	return nil, agentNotImplemented("agents.create")
}
func (a *AgentHandle) Get(ctx context.Context, sessionID string) (*AgentSession, error) {
	return nil, agentNotImplemented("agents.get")
}
func (s *AgentSession) Close(ctx context.Context, options AgentControlOptions) error {
	return agentNotImplemented("session.close")
}
func (s *AgentSession) Send(ctx context.Context, text string, options AgentSendOptions) (*AgentTurn, error) {
	return nil, agentNotImplemented("session.send")
}
func (s *AgentSession) GetTurn(ctx context.Context, turnID string) (*AgentTurn, error) {
	return nil, agentNotImplemented("session.get_turn")
}
func (s *AgentSession) Events(ctx context.Context, options AgentEventsOptions) (AgentEventStream, error) {
	return nil, agentNotImplemented("session.events")
}
func (s *AgentSession) Requests(ctx context.Context) ([]AgentRequest, error) {
	return nil, agentNotImplemented("session.requests")
}
func (s *AgentSession) Respond(ctx context.Context, requestID string, response AgentResponse, options AgentControlOptions) (*AgentTurn, error) {
	return nil, agentNotImplemented("session.respond")
}
func (s *AgentSession) State() (*AgentSessionState, error) {
	return nil, agentNotImplemented("session.state")
}
func (s *AgentSession) Config() (*AgentConfig, error) {
	return nil, agentNotImplemented("session.config")
}
func (s *AgentSession) Capabilities() (*AgentCapabilities, error) {
	return nil, agentNotImplemented("session.capabilities")
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
