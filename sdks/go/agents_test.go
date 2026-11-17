package boxlite

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func checkAgentError(t *testing.T, value any, err error, code ErrorCode) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("got %v, %v; want error code %v", value, err, code)
	}
	if value != nil && !reflect.ValueOf(value).IsZero() {
		t.Fatalf("error returned a value: %v", value)
	}
}

func TestAgentsRequireNativeHandles(t *testing.T) {
	ctx := context.Background()
	agents := (&Box{}).Agents()
	agent, turn := &Agent{}, &AgentTurn{}
	a, err := agents.Create(ctx, "agent", AgentCreateOptions{})
	checkAgentError(t, a, err, ErrInvalidState)
	a, err = agents.Get(ctx, "agent")
	checkAgentError(t, a, err, ErrInvalidState)
	checkAgentError(t, nil, agent.Close(ctx, AgentControlOptions{}), ErrInvalidState)
	for _, mode := range []AgentSendMode{"", AgentSendQueue, AgentSendReject} {
		got, err := agent.Send(ctx, "task", AgentSendOptions{Mode: mode})
		checkAgentError(t, got, err, ErrInvalidState)
	}
	got, err := agent.GetTurn(ctx, "turn")
	checkAgentError(t, got, err, ErrInvalidState)
	requests, err := agent.Requests(ctx)
	checkAgentError(t, requests, err, ErrInvalidState)
	for _, response := range []AgentResponse{AgentAnswer{Text: "answer"}, AgentPermissionResponse{Approved: false}} {
		got, err = agent.Respond(ctx, "request", response, AgentControlOptions{})
		checkAgentError(t, got, err, ErrInvalidState)
	}
	state, err := agent.State()
	checkAgentError(t, state, err, ErrInvalidState)
	config, err := agent.Config()
	checkAgentError(t, config, err, ErrInvalidState)
	capabilities, err := agent.Capabilities()
	checkAgentError(t, capabilities, err, ErrInvalidState)
	result, err := turn.Wait(ctx, AgentWaitOptions{})
	checkAgentError(t, result, err, ErrInvalidState)
	receipt, err := turn.Steer(ctx, "direction", AgentControlOptions{})
	checkAgentError(t, receipt, err, ErrInvalidState)
	checkAgentError(t, nil, turn.Interrupt(ctx, AgentControlOptions{}), ErrInvalidState)
	turnState, err := turn.State()
	checkAgentError(t, turnState, err, ErrInvalidState)
}

func TestAgentEventsRequireNativeHandles(t *testing.T) {
	ctx := context.Background()
	events, err := (&Agent{}).Events(ctx, AgentEventsOptions{})
	checkAgentError(t, events, err, ErrInvalidState)
	events, err = (&AgentTurn{}).Events(ctx, AgentEventsOptions{})
	checkAgentError(t, events, err, ErrInvalidState)
}
