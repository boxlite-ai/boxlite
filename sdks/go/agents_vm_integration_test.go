//go:build boxlite_dev && boxlite_agent_vm

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Invoked only by the Rust VM runner, which supplies the same model and inputs
// to C and Go. Getter/handle checks use production C/core, without a fake backend.
func TestGoAgentVMDriver(t *testing.T) {
	if len(os.Args) < 5 {
		t.Fatal("Rust runner must supply binary, config, home and registry")
	}
	args := os.Args[len(os.Args)-4:]
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	r, err := NewRuntime(WithHomeDir(args[2]), WithImageRegistries(ImageRegistry{Host: args[3], Transport: RegistryTransportHTTP, Search: true}))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	box, err := r.Create(ctx, "debian:bookworm-slim", WithAutoDeleteInterval(0))
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	if err := box.Start(ctx); err != nil {
		t.Fatal(err)
	}
	stopped := false
	defer func() {
		if !stopped {
			if err := box.Stop(ctx); err != nil {
				t.Error(err)
			}
		}
	}()
	shell := func(command string) {
		t.Helper()
		result, e := box.Exec(ctx, "sh", "-c", command)
		if e != nil {
			t.Fatal(e)
		}
		if result.ExitCode != 0 {
			t.Fatalf("shell: %+v", result)
		}
	}
	shell("mkdir -p /root/.config/opencode")
	for _, copy := range [][2]string{{args[0], "/usr/local/bin/opencode"}, {args[1], "/root/.config/opencode/opencode.json"}} {
		if e := box.CopyInto(ctx, copy[0], copy[1]); e != nil {
			t.Fatal(e)
		}
	}
	shell("chmod 755 /usr/local/bin/opencode")
	agent, err := box.Agents().Create(ctx, "opencode", AgentCreateOptions{Config: AgentConfig{Model: "fake/fake-model"}})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.KeepAlive(agent)
	state, err := agent.State()
	checkAgentError(t, state, err, ErrUnsupported)
	config, err := agent.Config()
	if err != nil || config.Model != "fake/fake-model" {
		t.Fatalf("config=%+v %v", config, err)
	}
	capabilities, err := agent.Capabilities()
	if err != nil {
		t.Fatal(err)
	}
	printVMRecord(t, "CONFIG", map[string]any{"model": config.Model})
	printVMRecord(t, "CAPABILITIES", map[string]any{"operations": capabilities.Operations})
	// Opening completes before send; the first record is retained for comparison.
	events, err := agent.Events(ctx, AgentEventsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer events.Close()
	turn, err := agent.Send(ctx, "hello", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ts, err := turn.State()
	if err != nil {
		t.Fatal(err)
	}
	printVMRecord(t, "TURN", map[string]any{"id": ts.ID, "agent_id": ts.AgentID, "status": ts.Status})
	timeout := 120 * time.Second
	result, err := turn.Wait(ctx, AgentWaitOptions{Timeout: &timeout})
	if err != nil {
		t.Fatal(err)
	}
	first, err := events.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	nullable := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	printVMRecord(t, "EVENT", map[string]any{"agent_id": first.AgentID, "turn_id": nullable(first.TurnID), "kind": first.Kind, "data": first.Data})
	printVMRecord(t, "RESULT", map[string]any{"turn_id": result.TurnID, "status": result.Status, "outcome": nullable(string(result.Outcome)), "text": nullable(result.Text), "data": result.Data, "artifacts": result.Artifacts, "usage": result.Usage, "error": nullable(result.Error)})
	receipt, err := turn.Steer(ctx, "continue", AgentControlOptions{})
	checkAgentError(t, receipt, err, ErrUnsupported)
	if !strings.Contains(err.Error(), "OpenCode 2.2") {
		t.Fatal(err)
	}
	adopted, err := box.Agents().Get(ctx, ts.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.KeepAlive(adopted)
	if _, err := adopted.Config(); err != nil {
		t.Fatal(err)
	}
	requests, err := agent.Requests(ctx)
	checkAgentError(t, requests, err, ErrUnsupported)
	slow, err := agent.Send(ctx, "SLOW", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	slowState, err := slow.State()
	if err != nil {
		t.Fatal(err)
	}
	// Real progress events provide the rendezvous; no sleeps or GC timing.
	for {
		event, e := events.Next(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if event.TurnID != slowState.ID {
			continue
		}
		probe, e := agent.GetTurn(ctx, slowState.ID)
		if e != nil {
			t.Fatal(e)
		}
		running, e := probe.State()
		probe.native.release()
		if e != nil {
			t.Fatal(e)
		}
		if running.Status == AgentTurnRunning {
			break
		}
		if running.Status == AgentTurnCompleted {
			t.Fatal("slow turn completed before release check")
		}
	}
	slow.native.release()
	released, err := slow.State()
	checkAgentError(t, released, err, ErrInvalidState)
	recovered, err := agent.GetTurn(ctx, slowState.ID)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := recovered.Wait(ctx, AgentWaitOptions{Timeout: &timeout})
	if err != nil || completed.Status != AgentTurnCompleted {
		t.Fatalf("released turn stopped: %+v %v", completed, err)
	}
	runtime.KeepAlive(recovered)
	runtime.KeepAlive(slow)
	runtime.KeepAlive(turn)
	events.Close()
	if err := box.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	stopped = true
	if err := r.Shutdown(ctx, 30*time.Second); err != nil {
		t.Fatal(err)
	}
	r.Close()
	config, err = agent.Config()
	if config != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("getter after runtime close=%+v %v", config, err)
	}
	caps, err := agent.Capabilities()
	if caps != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
	state, err = agent.State()
	if state != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
	finalState, err := turn.State()
	if finalState != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
}

func printVMRecord(t *testing.T, name string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("GO_%s=%s\n", name, data)
}
