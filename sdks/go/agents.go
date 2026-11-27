package boxlite

import (
	"context"
	"encoding/json"
	"sync"
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

// AgentEventsOptions groups the optional cursor to resume events after,
// where the adapter supports it.
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

// AgentCapabilities reports supported operations. A nil limit is unknown or
// unsupported, never zero. Cursors elsewhere are empty when not resumable.
type AgentCapabilities struct {
	Operations           []string
	InputKinds           []string
	MaxQueuedTurns       *uint
	MaxPendingSteering   *uint
	IdempotencyRetention *time.Duration
}
type AgentEvent struct {
	Cursor  string
	AgentID string
	TurnID  string
	Kind    string
	Data    json.RawMessage
}

// AgentEventStream reads the agent's events.
type AgentEventStream interface {
	Next(context.Context) (*AgentEvent, error)
	Close() error
}

// Agents, Agent and AgentTurn address agent conversations and work.
type Agents struct {
	mu     sync.Mutex
	box    *Box
	native *agentNamespace
}

// Agent represents an agent session. Pass the *Agent returned by the SDK.
// Do not copy the Agent value.
type Agent struct{ native *agentSession }

// AgentTurn represents one submitted task. Pass the *AgentTurn returned by the SDK.
// Do not copy the AgentTurn value.
type AgentTurn struct{ native *agentTurnHandle }

// Agents obtains the namespace without starting the Box.
func (b *Box) Agents() *Agents { return &Agents{box: b} }
