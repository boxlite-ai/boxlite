package boxlite

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"os"
	"reflect"
	"testing"
	"time"
)

func agentFixture(t *testing.T, name string) json.RawMessage {
	t.Helper()
	data, err := os.ReadFile("testdata/agents.json")
	if err != nil {
		t.Fatal(err)
	}
	var records map[string]json.RawMessage
	if err := json.Unmarshal(data, &records); err != nil {
		t.Fatal(err)
	}
	record, ok := records[name]
	if !ok {
		t.Fatalf("missing core fixture %q", name)
	}
	return record
}

func sameAgentJSON(t *testing.T, got, want []byte) {
	t.Helper()
	equal, err := equalAgentJSON(got, want)
	if err != nil {
		t.Fatal(err)
	}
	if !equal {
		t.Fatalf("JSON mismatch: got %s, want %s", got, want)
	}
}

func equalAgentJSON(got, want []byte) (bool, error) {
	var values [2]any
	for i, raw := range [][]byte{got, want} {
		if !json.Valid(raw) {
			return false, errors.New("invalid JSON")
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		// Compare numeric tokens exactly; only whitespace and object order are irrelevant.
		decoder.UseNumber()
		if err := decoder.Decode(&values[i]); err != nil {
			return false, err
		}
	}
	return reflect.DeepEqual(values[0], values[1]), nil
}

func TestAgentJSONComparisonPreservesNumbers(t *testing.T) {
	for _, tc := range []struct {
		left, right string
		equal       bool
	}{
		{`{"a":1,"b":[2]}`, ` {"b":[2],"a":1} `, true},
		{`9007199254740992`, `9007199254740993`, false},
		{`0.123456789012345678901`, `0.123456789012345678902`, false},
		{`{"nested":[9223372036854775806]}`, `{"nested":[9223372036854775807]}`, false},
		{`1e1000`, `2e1000`, false},
	} {
		equal, err := equalAgentJSON([]byte(tc.left), []byte(tc.right))
		if err != nil || equal != tc.equal {
			t.Errorf("compare %s and %s: %v, %v; want %v", tc.left, tc.right, equal, err, tc.equal)
		}
	}
	for _, invalid := range []string{``, `{`, `1 2`} {
		if _, err := equalAgentJSON([]byte(invalid), []byte(`null`)); err == nil {
			t.Errorf("invalid left JSON accepted: %q", invalid)
		}
		if _, err := equalAgentJSON([]byte(`null`), []byte(invalid)); err == nil {
			t.Errorf("invalid right JSON accepted: %q", invalid)
		}
	}
}

func sameAgentValue(t *testing.T, got, want any) {
	t.Helper()
	left, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	right, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	sameAgentJSON(t, left, right)
}

func agentField(t *testing.T, data []byte, key string, value json.RawMessage) []byte {
	t.Helper()
	var record map[string]json.RawMessage
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	record[key] = value
	updated, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	return updated
}

func TestAgentConfigJSONMatchesCore(t *testing.T) {
	for _, name := range []string{"config", "config_default"} {
		t.Run(name, func(t *testing.T) {
			fixture := agentFixture(t, name)
			config, err := parseAgentConfig(fixture)
			if err != nil {
				t.Fatal(err)
			}
			if config.Tools == nil || config.MCP == nil {
				t.Fatal("empty arrays must remain non-nil")
			}
			encoded, err := agentConfigJSON(*config)
			if err != nil {
				t.Fatal(err)
			}
			sameAgentJSON(t, encoded, fixture)
		})
	}
	encoded, err := agentConfigJSON(AgentConfig{})
	if err != nil {
		t.Fatal(err)
	}
	sameAgentJSON(t, encoded, agentFixture(t, "config_default"))
	encoded, err = agentConfigJSON(AgentConfig{
		Permissions: json.RawMessage(" null "), Limits: json.RawMessage("null"), OutputSchema: json.RawMessage("null"),
	})
	if err != nil {
		t.Fatal(err)
	}
	sameAgentJSON(t, encoded, agentFixture(t, "config_default"))
	tools := []string{"shell", "unchanged"}
	_, err = agentConfigJSON(AgentConfig{Tools: tools[:1], MCP: []string{"files"}})
	if err != nil || tools[1] != "unchanged" {
		t.Fatalf("encoding mutated caller storage: %v, %v", tools, err)
	}
}

type unknownAgentResponse struct{}

func (unknownAgentResponse) agentResponse() {}

func TestAgentResponsesMatchCore(t *testing.T) {
	var answer struct {
		Text string          `json:"text"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(agentFixture(t, "answer"), &answer); err != nil {
		t.Fatal(err)
	}
	value := AgentAnswer{Text: answer.Text, Data: answer.Data}
	denial := AgentPermissionResponse{Approved: false}
	approval := AgentPermissionResponse{Approved: true}
	for _, tc := range []struct {
		response AgentResponse
		fixture  string
	}{{value, "answer"}, {&value, "answer"}, {denial, "denial"}, {&denial, "denial"}, {approval, "approval"}} {
		encoded, err := agentResponseJSON(tc.response)
		if err != nil {
			t.Fatal(err)
		}
		sameAgentJSON(t, encoded, agentFixture(t, tc.fixture))
	}
	for _, raw := range []string{"false", "0", "[]", "{}", `{"nested":null}`} {
		encoded, err := agentResponseJSON(AgentAnswer{Text: "yes", Data: json.RawMessage(raw)})
		if err != nil {
			t.Fatal(err)
		}
		var record map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &record); err != nil {
			t.Fatal(err)
		}
		sameAgentJSON(t, record["data"], []byte(raw))
		if _, ok := record["approved"]; ok {
			t.Fatal("an answer must not authorize permission")
		}
	}
	encoded, err := agentResponseJSON(AgentAnswer{Text: "yes", Data: json.RawMessage("null")})
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &record); err != nil {
		t.Fatal(err)
	}
	if _, ok := record["data"]; ok {
		t.Fatal("top-level null optional data must normalize to omitted")
	}
}

func TestAgentJSONRejectsInvalidInputs(t *testing.T) {
	var answer *AgentAnswer
	var permission *AgentPermissionResponse
	for _, response := range []AgentResponse{nil, answer, permission, unknownAgentResponse{}, AgentAnswer{Data: json.RawMessage("{")}, AgentAnswer{Text: string([]byte{0xff})}} {
		encoded, err := agentResponseJSON(response)
		var typed *Error
		if encoded != nil || !errors.As(err, &typed) || typed.Code != ErrInvalidArgument {
			t.Fatalf("invalid response %T returned %s, %v", response, encoded, err)
		}
	}
	for _, config := range []AgentConfig{
		{Model: string([]byte{0xff})}, {Tools: []string{string([]byte{0xff})}},
		{Permissions: json.RawMessage("{")}, {Limits: json.RawMessage("{")}, {OutputSchema: json.RawMessage("{")},
	} {
		if encoded, err := agentConfigJSON(config); encoded != nil || err == nil {
			t.Fatalf("invalid config returned %s, %v", encoded, err)
		}
	}
}

func TestAgentCapabilitiesFromCore(t *testing.T) {
	capabilities, err := parseAgentCapabilities(agentFixture(t, "capabilities"))
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.MaxQueuedTurns == nil || *capabilities.MaxQueuedTurns != 0 || capabilities.MaxPendingSteering != nil {
		t.Fatalf("null and zero limits were conflated: %+v", capabilities)
	}
	if capabilities.IdempotencyRetention == nil || *capabilities.IdempotencyRetention != 1500*time.Millisecond || !reflect.DeepEqual(capabilities.InputKinds, []string{"text"}) {
		t.Fatalf("capabilities mapping: %+v", capabilities)
	}
	unknown, err := parseAgentCapabilities(agentFixture(t, "capabilities_unknown"))
	if err != nil || unknown.MaxQueuedTurns != nil || unknown.IdempotencyRetention != nil || unknown.Operations == nil || unknown.InputKinds == nil {
		t.Fatalf("unknown capabilities: %+v, %v", unknown, err)
	}
}

func TestAgentRetentionDecimalBoundaries(t *testing.T) {
	for _, tc := range []struct {
		json string
		want time.Duration
	}{
		{"0", 0}, {"0.000000001", 1}, {"1e-9", 1}, {"0.0000000009", 0}, {"1.5", 1500 * time.Millisecond},
		{"9223372036.854775806", time.Duration(math.MaxInt64 - 1)}, {"9223372036.854775807", time.Duration(math.MaxInt64)},
	} {
		t.Run(tc.json, func(t *testing.T) {
			input := agentField(t, agentFixture(t, "capabilities"), "idempotency_retention_seconds", json.RawMessage(tc.json))
			got, err := parseAgentCapabilities(input)
			if err != nil || got.IdempotencyRetention == nil || *got.IdempotencyRetention != tc.want {
				t.Fatalf("retention %s: %+v, %v; want %v", tc.json, got, err, tc.want)
			}
		})
	}
	for _, raw := range []string{"-1", "9223372036.854775808", "9223372036.8547758071", `"1"`, "true", "{}", "[]"} {
		input := agentField(t, agentFixture(t, "capabilities"), "idempotency_retention_seconds", json.RawMessage(raw))
		if got, err := parseAgentCapabilities(input); got != nil || err == nil {
			t.Fatalf("invalid retention %s: %+v, %v", raw, got, err)
		}
	}
}

func TestAgentRetentionBoundariesFromCore(t *testing.T) {
	got, err := parseAgentCapabilities(agentFixture(t, "capabilities_max"))
	if err != nil || got.IdempotencyRetention == nil || *got.IdempotencyRetention != time.Duration(math.MaxInt64) {
		t.Fatalf("core maximum retention: %+v, %v", got, err)
	}
	if got, err := parseAgentCapabilities(agentFixture(t, "capabilities_overflow")); got != nil || err == nil {
		t.Fatalf("core overflow retention: %+v, %v", got, err)
	}
}

func TestAgentCapabilityIntegerBoundaries(t *testing.T) {
	for _, field := range []string{"max_queued_turns", "max_pending_steering"} {
		for _, want := range []uint{0, 1, ^uint(0)} {
			raw, err := json.Marshal(want)
			if err != nil {
				t.Fatal(err)
			}
			got, err := parseAgentCapabilities(agentField(t, agentFixture(t, "capabilities"), field, raw))
			if err != nil {
				t.Fatal(err)
			}
			value := got.MaxQueuedTurns
			if field == "max_pending_steering" {
				value = got.MaxPendingSteering
			}
			if value == nil || *value != want {
				t.Fatalf("%s: got %v, want %d", field, value, want)
			}
		}
		for _, raw := range []string{"1.5", "18446744073709551616"} {
			got, err := parseAgentCapabilities(agentField(t, agentFixture(t, "capabilities"), field, json.RawMessage(raw)))
			if got != nil || err == nil {
				t.Fatalf("%s accepted %s: %+v, %v", field, raw, got, err)
			}
		}
	}
}

func TestAgentNumericPayloadsFromCore(t *testing.T) {
	numbers := agentFixture(t, "numeric_data")
	sameAgentJSON(t, numbers, []byte(`[9007199254740992,9007199254740993,-9223372036854775808,9223372036854775807,18446744073709551615,0.123456789012345678901,0.123456789012345678902]`))
	config, err := parseAgentConfig(agentFixture(t, "numeric_config"))
	if err != nil {
		t.Fatal(err)
	}
	for _, data := range []json.RawMessage{config.Limits, config.Permissions, config.OutputSchema} {
		sameAgentJSON(t, data, numbers)
	}
	encoded, err := agentConfigJSON(*config)
	if err != nil {
		t.Fatal(err)
	}
	sameAgentJSON(t, encoded, agentFixture(t, "numeric_config"))
	result, err := parseAgentResult(agentFixture(t, "result"))
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(result.Data, &payload); err != nil {
		t.Fatal(err)
	}
	sameAgentJSON(t, payload["numbers"], numbers)
	encoded, err = agentResponseJSON(AgentAnswer{Text: "yes", Data: result.Data})
	if err != nil {
		t.Fatal(err)
	}
	sameAgentJSON(t, encoded, agentFixture(t, "answer"))
}

func TestAgentRecordsFromCore(t *testing.T) {
	state, err := parseAgentState(agentFixture(t, "state"))
	if err != nil {
		t.Fatal(err)
	}
	if state.ID != "agent-1" || state.Status != AgentBusy || state.Cursor != "" || state.ActiveTurnID != "turn-1" || !reflect.DeepEqual(state.QueuedTurnIDs, []string{"turn-2"}) {
		t.Fatalf("state mapping: %+v", state)
	}
	if len(state.Requests) != 2 || len(state.Steering) != 1 {
		t.Fatalf("missing nested records: %+v", state)
	}
	question, ok := state.Requests[0].Kind.(AgentQuestion)
	if !ok || question.Text != "continue?" || question.Schema != nil || state.Requests[0].TurnID != "turn-1" {
		t.Fatalf("question mapping: %+v", state.Requests[0])
	}
	permission, ok := state.Requests[1].Kind.(AgentPermission)
	if !ok || permission.Tool != "shell" {
		t.Fatalf("permission mapping: %+v", state.Requests[1])
	}
	requests, err := parseAgentRequests(agentFixture(t, "requests"))
	if err != nil {
		t.Fatalf("requests mapping: %+v, %v", requests, err)
	}
	sameAgentValue(t, requests, state.Requests)
	result, err := parseAgentResult(agentFixture(t, "result"))
	if err != nil {
		t.Fatal(err)
	}
	if result.TurnID != "turn-1" || result.Status != AgentTurnCompleted || result.Outcome != AgentOutcomeAnswer || result.Text != "done" || result.Error != "" || result.Artifacts == nil {
		t.Fatalf("result mapping: %+v", result)
	}
	sameAgentJSON(t, result.Data, permission.Arguments)
	sameAgentJSON(t, result.Usage, []byte(`{"tokens":0}`))
	turn, err := parseAgentTurnState(agentFixture(t, "turn"))
	if err != nil || turn.ID != "turn-1" || turn.AgentID != "agent-1" {
		t.Fatalf("turn mapping: %+v, %v", turn, err)
	}
	sameAgentValue(t, turn.Result, result)
	sameAgentValue(t, turn.Requests, requests)
	receipt, err := parseAgentReceipt(agentFixture(t, "receipt"))
	if err != nil || receipt.ID != "steer-1" || receipt.TurnID != "turn-1" || receipt.Status != AgentSteeringApplied || !reflect.DeepEqual(*receipt, turn.Steering[0]) {
		t.Fatalf("receipt mapping: %+v, %v", receipt, err)
	}
	event, err := parseAgentEvent(agentFixture(t, "event"))
	if err != nil || event.AgentID != "agent-1" || event.TurnID != "" || event.Cursor != "" || event.Kind != "progress" {
		t.Fatalf("event mapping: %+v, %v", event, err)
	}
	sameAgentJSON(t, event.Data, result.Data)
}

func TestAgentRecordsPreserveNullAndEmpty(t *testing.T) {
	state, err := parseAgentState(agentFixture(t, "state_empty"))
	if err != nil || state.ActiveTurnID != "" || state.QueuedTurnIDs == nil || state.Requests == nil || state.Steering == nil {
		t.Fatalf("empty state: %+v, %v", state, err)
	}
	turn, err := parseAgentTurnState(agentFixture(t, "turn_queued"))
	if err != nil || turn.Result != nil || turn.Requests == nil || turn.Steering == nil {
		t.Fatalf("empty turn: %+v, %v", turn, err)
	}
	result, err := parseAgentResult(agentFixture(t, "result_unknown"))
	if err != nil || result.Status != AgentTurnUnknown || result.Text != "" || result.Outcome != "" || result.Data != nil || result.Usage != nil || result.Artifacts == nil {
		t.Fatalf("nullable result: %+v, %v", result, err)
	}
}

func TestAgentMandatoryRawNullIsPreserved(t *testing.T) {
	event, err := parseAgentEvent(agentFixture(t, "event_null"))
	if err != nil || string(event.Data) != "null" {
		t.Fatalf("required event data lost JSON null: %+v, %v", event, err)
	}
	requests, err := parseAgentRequests(agentFixture(t, "requests_null"))
	if err != nil || len(requests) != 1 {
		t.Fatalf("null permission fixture: %+v, %v", requests, err)
	}
	permission, ok := requests[0].Kind.(AgentPermission)
	if !ok || string(permission.Arguments) != "null" {
		t.Fatalf("required permission arguments lost JSON null: %+v", requests[0])
	}
}

func TestAgentRecordsRejectWrongTypes(t *testing.T) {
	for _, tc := range []struct {
		name, field, invalid string
		decode               func([]byte) error
	}{
		{"config", "model", "7", func(b []byte) error { _, err := parseAgentConfig(b); return err }},
		{"config", "tools", `"shell"`, func(b []byte) error { _, err := parseAgentConfig(b); return err }},
		{"capabilities", "max_queued_turns", "-1", func(b []byte) error { _, err := parseAgentCapabilities(b); return err }},
		{"state", "queued_turn_ids", "false", func(b []byte) error { _, err := parseAgentState(b); return err }},
		{"turn", "result", "[]", func(b []byte) error { _, err := parseAgentTurnState(b); return err }},
		{"result", "text", "0", func(b []byte) error { _, err := parseAgentResult(b); return err }},
		{"receipt", "status", "true", func(b []byte) error { _, err := parseAgentReceipt(b); return err }},
		{"event", "turn_id", "{}", func(b []byte) error { _, err := parseAgentEvent(b); return err }},
	} {
		t.Run(tc.name+"/"+tc.field, func(t *testing.T) {
			invalid := agentField(t, agentFixture(t, tc.name), tc.field, json.RawMessage(tc.invalid))
			var typed *Error
			if err := tc.decode(invalid); !errors.As(err, &typed) || typed.Code != ErrInternal {
				t.Fatalf("wrong field type was not rejected: %v", err)
			}
			for _, input := range [][]byte{nil, []byte("null"), []byte("[]"), []byte("{"), []byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}} {
				if err := tc.decode(input); err == nil {
					t.Fatalf("accepted invalid record: %q", input)
				}
			}
		})
	}
	for _, input := range []string{`[{"kind":{"type":"future"}}]`, `[{"kind":{"type":"question","text":false}}]`, `[{"kind":null}]`, "null", "{}", "["} {
		if requests, err := parseAgentRequests([]byte(input)); requests != nil || err == nil {
			t.Fatalf("invalid request kind accepted: %s => %+v, %v", input, requests, err)
		}
	}
}

func TestAgentSnapshotsRejectUnknownNestedRequests(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		decode  func([]byte) error
	}{
		{"state", func(data []byte) error { _, err := parseAgentState(data); return err }},
		{"turn", func(data []byte) error { _, err := parseAgentTurnState(data); return err }},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			input := agentField(t, agentFixture(t, tc.fixture), "requests", json.RawMessage(`[{"id":"request-1","kind":{"type":"future"}}]`))
			var typed *Error
			if err := tc.decode(input); !errors.As(err, &typed) || typed.Code != ErrInternal {
				t.Fatalf("unknown nested request kind was accepted: %v", err)
			}
		})
	}
}

func TestAgentFutureStatusesAndFields(t *testing.T) {
	stateJSON := agentField(t, agentFixture(t, "state"), "status", json.RawMessage(`"future"`))
	stateJSON = agentField(t, stateJSON, "new_field", json.RawMessage("true"))
	state, err := parseAgentState(stateJSON)
	if err != nil || state.Status != AgentUnknown {
		t.Fatalf("future agent status: %+v, %v", state, err)
	}
	turn, err := parseAgentTurnState(agentField(t, agentFixture(t, "turn"), "status", json.RawMessage(`"future"`)))
	if err != nil || turn.Status != AgentTurnUnknown {
		t.Fatalf("future turn status: %+v, %v", turn, err)
	}
	receipt, err := parseAgentReceipt(agentField(t, agentFixture(t, "receipt"), "status", json.RawMessage(`"future"`)))
	if err != nil || receipt.Status != AgentSteeringUnknown {
		t.Fatalf("future steering status: %+v, %v", receipt, err)
	}
}
