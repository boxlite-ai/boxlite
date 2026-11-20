package boxlite

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"time"
	"unicode/utf8"
)

type agentConfigRecord struct {
	Model        string          `json:"model,omitempty"`
	Reasoning    string          `json:"reasoning,omitempty"`
	Instructions string          `json:"instructions,omitempty"`
	Tools        []string        `json:"tools"`
	MCP          []string        `json:"mcp"`
	Permissions  json.RawMessage `json:"permissions,omitempty"`
	Limits       json.RawMessage `json:"limits,omitempty"`
	OutputSchema json.RawMessage `json:"output_schema,omitempty"`
}

func agentConfigJSON(config AgentConfig) ([]byte, error) {
	for _, group := range [][]string{{config.Model, config.Reasoning, config.Instructions}, config.Tools, config.MCP} {
		for _, value := range group {
			if !utf8.ValidString(value) {
				return nil, agentJSONError(ErrInvalidArgument, "config contains invalid UTF-8")
			}
		}
	}
	for _, value := range []json.RawMessage{config.Permissions, config.Limits, config.OutputSchema} {
		if len(value) != 0 && (!utf8.Valid(value) || !json.Valid(value)) {
			return nil, agentJSONError(ErrInvalidArgument, "config contains invalid JSON")
		}
	}
	return json.Marshal(agentConfigRecord{
		Model: config.Model, Reasoning: config.Reasoning, Instructions: config.Instructions,
		Tools: agentSlice(config.Tools), MCP: agentSlice(config.MCP),
		Permissions: agentRaw(config.Permissions), Limits: agentRaw(config.Limits), OutputSchema: agentRaw(config.OutputSchema),
	})
}

func parseAgentConfig(data []byte) (*AgentConfig, error) {
	var record agentConfigRecord
	if err := decodeAgentRecord(data, &record); err != nil {
		return nil, err
	}
	return &AgentConfig{
		Model: record.Model, Reasoning: record.Reasoning, Instructions: record.Instructions,
		Tools: agentSlice(record.Tools), MCP: agentSlice(record.MCP),
		Permissions: agentRaw(record.Permissions), Limits: agentRaw(record.Limits), OutputSchema: agentRaw(record.OutputSchema),
	}, nil
}

func agentResponseJSON(response AgentResponse) ([]byte, error) {
	switch value := response.(type) {
	case AgentAnswer:
		if !utf8.ValidString(value.Text) || (len(value.Data) != 0 && (!utf8.Valid(value.Data) || !json.Valid(value.Data))) {
			return nil, agentJSONError(ErrInvalidArgument, "answer contains invalid UTF-8 or JSON")
		}
		return json.Marshal(struct {
			Type string          `json:"type"`
			Text string          `json:"text"`
			Data json.RawMessage `json:"data,omitempty"`
		}{"answer", value.Text, agentRaw(value.Data)})
	case AgentPermissionResponse:
		return json.Marshal(struct {
			Type     string `json:"type"`
			Approved bool   `json:"approved"`
		}{"permission", value.Approved})
	case *AgentAnswer:
		if value != nil {
			return agentResponseJSON(*value)
		}
	case *AgentPermissionResponse:
		if value != nil {
			return agentResponseJSON(*value)
		}
	}
	return nil, agentJSONError(ErrInvalidArgument, "unsupported or nil agent response")
}

func parseAgentCapabilities(data []byte) (*AgentCapabilities, error) {
	var record struct {
		Operations           []string        `json:"operations"`
		InputKinds           []string        `json:"input_kinds"`
		MaxQueuedTurns       *uint           `json:"max_queued_turns"`
		MaxPendingSteering   *uint           `json:"max_pending_steering"`
		IdempotencyRetention json.RawMessage `json:"idempotency_retention_seconds"`
	}
	if err := decodeAgentRecord(data, &record); err != nil {
		return nil, err
	}
	retention, err := agentRetention(record.IdempotencyRetention)
	if err != nil {
		return nil, err
	}
	return &AgentCapabilities{
		Operations: agentSlice(record.Operations), InputKinds: agentSlice(record.InputKinds),
		MaxQueuedTurns: record.MaxQueuedTurns, MaxPendingSteering: record.MaxPendingSteering, IdempotencyRetention: retention,
	}, nil
}

func agentRetention(raw json.RawMessage) (*time.Duration, error) {
	raw = agentRaw(raw)
	if len(raw) == 0 {
		return nil, nil
	}
	var number json.Number
	if raw[0] == '"' || json.Unmarshal(raw, &number) != nil {
		return nil, agentJSONError(ErrInternal, "retention must be a number or null")
	}
	seconds, ok := new(big.Rat).SetString(string(number))
	if !ok || seconds.Sign() < 0 {
		return nil, agentJSONError(ErrInternal, "invalid retention seconds")
	}
	nanos := seconds.Mul(seconds, big.NewRat(int64(time.Second), 1))
	if nanos.Cmp(big.NewRat(math.MaxInt64, 1)) > 0 {
		return nil, agentJSONError(ErrInternal, "retention exceeds time.Duration")
	}
	duration := time.Duration(new(big.Int).Quo(nanos.Num(), nanos.Denom()).Int64())
	return &duration, nil
}

func decodeAgentRecord(data []byte, record any) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' || !utf8.Valid(data) {
		return agentJSONError(ErrInternal, "expected an agent JSON object")
	}
	if err := json.Unmarshal(data, record); err != nil {
		return agentJSONError(ErrInternal, fmt.Sprintf("invalid agent record: %v", err))
	}
	return nil
}

func agentJSONError(code ErrorCode, message string) error {
	return &Error{Code: code, Message: message}
}

func agentRaw(raw json.RawMessage) json.RawMessage {
	raw = bytes.TrimSpace(raw)
	if bytes.Equal(raw, []byte("null")) {
		return nil
	}
	return raw
}

func agentSlice[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
