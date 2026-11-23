package boxlite

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

type agentReceiptRecord struct {
	ID     string `json:"id"`
	TurnID string `json:"turn_id"`
	Status string `json:"status"`
}

func (r agentReceiptRecord) value() AgentSteeringReceipt {
	status := AgentSteeringStatus(r.Status)
	switch status {
	case AgentSteeringAccepted, AgentSteeringApplied, AgentSteeringUnused:
	default:
		status = AgentSteeringUnknown
	}
	return AgentSteeringReceipt{ID: r.ID, TurnID: r.TurnID, Status: status}
}

type agentResultRecord struct {
	TurnID    string          `json:"turn_id"`
	Status    string          `json:"status"`
	Outcome   string          `json:"outcome"`
	Text      string          `json:"text"`
	Data      json.RawMessage `json:"data"`
	Artifacts []string        `json:"artifacts"`
	Usage     json.RawMessage `json:"usage"`
	Error     string          `json:"error"`
}

func (r agentResultRecord) value() *AgentResult {
	return &AgentResult{
		TurnID: r.TurnID, Status: agentTurnStatus(r.Status), Outcome: AgentOutcome(r.Outcome), Text: r.Text,
		Data: agentRaw(r.Data), Artifacts: agentSlice(r.Artifacts), Usage: agentRaw(r.Usage), Error: r.Error,
	}
}

type agentRequestRecord struct {
	ID     string `json:"id"`
	TurnID string `json:"turn_id"`
	Kind   struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		Schema    json.RawMessage `json:"schema"`
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"kind"`
}

func agentRequests(records []agentRequestRecord) ([]AgentRequest, error) {
	requests := make([]AgentRequest, 0, len(records))
	for _, record := range records {
		var kind AgentRequestKind
		switch record.Kind.Type {
		case "question":
			kind = AgentQuestion{Text: record.Kind.Text, Schema: agentRaw(record.Kind.Schema)}
		case "permission":
			kind = AgentPermission{Tool: record.Kind.Tool, Arguments: record.Kind.Arguments}
		default:
			return nil, agentJSONError(ErrInternal, "unknown agent request kind")
		}
		requests = append(requests, AgentRequest{ID: record.ID, TurnID: record.TurnID, Kind: kind})
	}
	return requests, nil
}

type agentSnapshotRecord struct {
	ID       string               `json:"id"`
	Status   string               `json:"status"`
	Cursor   string               `json:"cursor"`
	Requests []agentRequestRecord `json:"requests"`
	Steering []agentReceiptRecord `json:"steering"`
}

func (r agentSnapshotRecord) receipts() []AgentSteeringReceipt {
	receipts := make([]AgentSteeringReceipt, 0, len(r.Steering))
	for _, receipt := range r.Steering {
		receipts = append(receipts, receipt.value())
	}
	return receipts
}

func parseAgentState(data []byte) (*AgentState, error) {
	var record struct {
		agentSnapshotRecord
		ActiveTurnID  string   `json:"active_turn_id"`
		QueuedTurnIDs []string `json:"queued_turn_ids"`
	}
	if err := decodeAgentRecord(data, &record); err != nil {
		return nil, err
	}
	requests, err := agentRequests(record.Requests)
	if err != nil {
		return nil, err
	}
	status := AgentStatus(record.Status)
	switch status {
	case AgentReady, AgentBusy, AgentClosing, AgentClosed:
	default:
		status = AgentUnknown
	}
	return &AgentState{
		ID: record.ID, Status: status, Cursor: record.Cursor, ActiveTurnID: record.ActiveTurnID,
		QueuedTurnIDs: agentSlice(record.QueuedTurnIDs), Requests: requests, Steering: record.receipts(),
	}, nil
}

func parseAgentTurnState(data []byte) (*AgentTurnState, error) {
	var record struct {
		agentSnapshotRecord
		AgentID string             `json:"agent_id"`
		Result  *agentResultRecord `json:"result"`
	}
	if err := decodeAgentRecord(data, &record); err != nil {
		return nil, err
	}
	requests, err := agentRequests(record.Requests)
	if err != nil {
		return nil, err
	}
	state := &AgentTurnState{
		ID: record.ID, AgentID: record.AgentID, Status: agentTurnStatus(record.Status), Cursor: record.Cursor,
		Requests: requests, Steering: record.receipts(),
	}
	if record.Result != nil {
		state.Result = record.Result.value()
	}
	return state, nil
}

func parseAgentResult(data []byte) (*AgentResult, error) {
	var record agentResultRecord
	if err := decodeAgentRecord(data, &record); err != nil {
		return nil, err
	}
	return record.value(), nil
}

func parseAgentReceipt(data []byte) (*AgentSteeringReceipt, error) {
	var record agentReceiptRecord
	if err := decodeAgentRecord(data, &record); err != nil {
		return nil, err
	}
	receipt := record.value()
	return &receipt, nil
}

func parseAgentRequests(data []byte) ([]AgentRequest, error) {
	data = bytes.TrimSpace(data)
	var records []agentRequestRecord
	if len(data) == 0 || data[0] != '[' || !utf8.Valid(data) {
		return nil, agentJSONError(ErrInternal, "expected an agent request array")
	}
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, agentJSONError(ErrInternal, "invalid agent request record: "+err.Error())
	}
	return agentRequests(records)
}

func parseAgentEvent(data []byte) (*AgentEvent, error) {
	var record struct {
		Cursor  string          `json:"cursor"`
		AgentID string          `json:"agent_id"`
		TurnID  string          `json:"turn_id"`
		Kind    string          `json:"kind"`
		Data    json.RawMessage `json:"data"`
	}
	if err := decodeAgentRecord(data, &record); err != nil {
		return nil, err
	}
	return &AgentEvent{
		Cursor: record.Cursor, AgentID: record.AgentID, TurnID: record.TurnID, Kind: record.Kind, Data: record.Data,
	}, nil
}

func agentTurnStatus(value string) AgentTurnStatus {
	status := AgentTurnStatus(value)
	switch status {
	case AgentTurnQueued, AgentTurnRunning, AgentTurnWaitingInput, AgentTurnInterrupting, AgentTurnCompleted, AgentTurnCancelled, AgentTurnFailed:
		return status
	default:
		return AgentTurnUnknown
	}
}
