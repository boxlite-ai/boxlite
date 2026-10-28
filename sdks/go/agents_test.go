package boxlite

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestAgentsReturnUnsupported(t *testing.T) {
	ctx := context.Background()
	// A namespace operation must not touch the absent native Box/runtime.
	agents := (&Box{}).Agents()
	session, turn := &AgentSession{}, &AgentTurn{}
	check := func(name string, value any, err error) {
		t.Helper()
		var typed *Error
		if !errors.As(err, &typed) || typed.Code != ErrUnsupported || !strings.Contains(typed.Message, name+" is not implemented") {
			t.Fatalf("%s returned %v, %v", name, value, err)
		}
	}
	s, err := agents.Create(ctx, "agent", AgentCreateOptions{})
	check("agents.create", s, err)
	s, err = agents.Get(ctx, "session")
	check("agents.get", s, err)
	check("session.close", nil, session.Close(ctx, AgentControlOptions{}))
	for _, mode := range []AgentSendMode{"", AgentSendQueue, AgentSendReject} {
		got, err := session.Send(ctx, "task", AgentSendOptions{Mode: mode})
		check("session.send", got, err)
	}
	got, err := session.GetTurn(ctx, "turn")
	check("session.get_turn", got, err)
	events, err := session.Events(ctx, AgentEventsOptions{After: "cursor"})
	check("session.events", events, err)
	if events != nil {
		t.Fatal("failed event opening must not return a stream")
	}
	requests, err := session.Requests(ctx)
	check("session.requests", requests, err)
	for _, response := range []AgentResponse{AgentAnswer{Text: "answer"}, AgentPermissionResponse{Approved: false}} {
		got, err = session.Respond(ctx, "request", response, AgentControlOptions{})
		check("session.respond", got, err)
	}
	state, err := session.State()
	check("session.state", state, err)
	config, err := session.Config()
	check("session.config", config, err)
	capabilities, err := session.Capabilities()
	check("session.capabilities", capabilities, err)
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
