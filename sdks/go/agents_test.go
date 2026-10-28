package boxlite

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestAgentsReturnUnsupported(t *testing.T) {
	ctx := context.Background()
	// A namespace operation must not touch the absent native Box/runtime.
	agents := (&Box{}).Agents()
	agent, turn := &Agent{}, &AgentTurn{}
	check := func(name string, value any, err error) {
		t.Helper()
		var typed *Error
		if !errors.As(err, &typed) || typed.Code != ErrUnsupported || !strings.Contains(typed.Message, name+" is not implemented") {
			t.Fatalf("%s returned %v, %v", name, value, err)
		}
		if value != nil && !reflect.ValueOf(value).IsZero() {
			t.Fatalf("%s returned a value with an error: %v", name, value)
		}
	}
	s, err := agents.Create(ctx, "agent", AgentCreateOptions{})
	check("agents.create", s, err)
	s, err = agents.Get(ctx, "agent")
	check("agents.get", s, err)
	check("agent.close", nil, agent.Close(ctx, AgentControlOptions{}))
	for _, mode := range []AgentSendMode{"", AgentSendQueue, AgentSendReject} {
		got, err := agent.Send(ctx, "task", AgentSendOptions{Mode: mode})
		check("agent.send", got, err)
	}
	got, err := agent.GetTurn(ctx, "turn")
	check("agent.get_turn", got, err)
	events, err := agent.Events(ctx, AgentEventsOptions{After: "cursor"})
	check("agent.events", events, err)
	if events != nil {
		t.Fatal("failed event opening must not return a stream")
	}
	requests, err := agent.Requests(ctx)
	check("agent.requests", requests, err)
	for _, response := range []AgentResponse{AgentAnswer{Text: "answer"}, AgentPermissionResponse{Approved: false}} {
		got, err = agent.Respond(ctx, "request", response, AgentControlOptions{})
		check("agent.respond", got, err)
	}
	state, err := agent.State()
	check("agent.state", state, err)
	config, err := agent.Config()
	check("agent.config", config, err)
	capabilities, err := agent.Capabilities()
	check("agent.capabilities", capabilities, err)
	result, err := turn.Wait(ctx, AgentWaitOptions{})
	check("turn.wait", result, err)
	events, err = turn.Events(ctx, AgentEventsOptions{})
	check("turn.events", events, err)
	if events != nil {
		t.Fatal("failed event opening must not return a stream")
	}
	receipt, err := turn.Steer(ctx, "direction", AgentControlOptions{})
	check("turn.steer", receipt, err)
	check("turn.interrupt", nil, turn.Interrupt(ctx, AgentControlOptions{}))
	turnState, err := turn.State()
	check("turn.state", turnState, err)
}
