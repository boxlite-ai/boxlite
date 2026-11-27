//go:build boxlite_dev && boxlite_agent_vm

package boxlite

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const goAgentServiceRecord = "/root/.local/state/opencode/service.json"

type goAgentVMFixture struct {
	t      *testing.T
	ctx    context.Context
	rt     *Runtime
	box    *Box
	binary string
}

// Subtest names match src/boxlite/tests/agents_opencode.rs exactly.
func TestGoAgentVMParity(t *testing.T) {
	tests := []struct {
		name string
		run  func(*goAgentVMFixture)
	}{
		{"opencode_agent_creates_sends_streams_and_waits", goAgentConcurrentCreate},
		{"an_old_turn_is_read_beyond_the_first_history_page", goAgentHistoryPagination},
		{"a_box_restart_resumes_the_running_turn_and_delivers_the_queued_one", goAgentRunningRestart},
		{"a_foreign_server_on_the_agent_port_is_reported", goAgentForeignServer},
		{"a_box_without_opencode_is_reported", goAgentMissingBinary},
		{"a_user_service_is_refused_ready_or_frozen_and_left_running", goAgentUserService},
		{"a_stale_registration_is_dropped_without_signalling_its_pid", goAgentStaleRegistration},
		{"sessions_deny_env_reads_and_questions_and_keep_running", goAgentPermissionBoundaries},
		{"a_frozen_agent_service_is_reported_and_left_alone", goAgentFrozenService},
		{"remote_access_is_refused_before_a_service_starts", goAgentRemoteService},
		{"an_installed_opencode_runs_in_an_image_without_one", goAgentInstalledBinary},
		{"installing_again_reuses_the_one_mount", goAgentRepeatedInstall},
		{"an_agent_installed_after_a_failed_lookup_is_found_at_once", goAgentInstallAfterLookup},
		{"a_restart_mounts_the_recorded_agent_on_first_use", goAgentInstalledRestart},
		{"a_failed_mount_after_a_restart_is_reported_and_retried", goAgentMountRetry},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) { test.run(newGoAgentVMFixture(t)) })
	}
}

func newGoAgentVMFixture(t *testing.T) *goAgentVMFixture {
	t.Helper()
	if len(os.Args) < 5 {
		t.Fatal("run through make test:integration:go:agents")
	}
	args := os.Args[len(os.Args)-4:]
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	t.Cleanup(cancel)
	r, err := NewRuntime(WithHomeDir(t.TempDir()), WithImageRegistries(ImageRegistry{Host: args[3], Transport: RegistryTransportHTTP, Search: true}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	box, err := r.Create(ctx, "debian:bookworm-slim", WithAutoDeleteInterval(0), WithEnv("OPENCODE_PASSWORD", "inherited-from-the-box"))
	if err != nil {
		t.Fatal(err)
	}
	f := &goAgentVMFixture{t: t, ctx: ctx, rt: r, box: box, binary: args[0]}
	t.Cleanup(func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := r.Shutdown(shutdown, 30*time.Second); err != nil {
			t.Error(err)
		}
		f.box.Close()
	})
	if err := box.Start(ctx); err != nil {
		t.Fatal(err)
	}
	f.shell("mkdir -p /root/.config/opencode")
	for _, copy := range [][2]string{{args[0], "/usr/local/bin/opencode"}, {args[1], "/root/.config/opencode/opencode.json"}} {
		if err := box.CopyInto(ctx, copy[0], copy[1]); err != nil {
			t.Fatal(err)
		}
	}
	f.shell("chmod 755 /usr/local/bin/opencode")
	return f
}
func (f *goAgentVMFixture) shell(script string) string {
	f.t.Helper()
	r, err := f.box.Exec(f.ctx, "sh", "-c", script)
	if err != nil {
		f.t.Fatal(err)
	}
	if r.ExitCode != 0 {
		f.t.Fatalf("script %q failed: %+v", script, r)
	}
	return strings.TrimSpace(r.Stdout)
}
func (f *goAgentVMFixture) create() *Agent {
	f.t.Helper()
	a, err := f.box.Agents().Create(f.ctx, "opencode", AgentCreateOptions{Config: AgentConfig{Model: "fake/fake-model"}})
	if err != nil {
		f.t.Fatal(err)
	}
	return a
}
func (f *goAgentVMFixture) send(a *Agent, text string) *AgentTurn {
	f.t.Helper()
	turn, err := a.Send(f.ctx, text, AgentSendOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	return turn
}
func (f *goAgentVMFixture) snapshot(turn *AgentTurn) *AgentTurnState {
	f.t.Helper()
	s, err := turn.State()
	if err != nil {
		f.t.Fatal(err)
	}
	return s
}
func (f *goAgentVMFixture) wait(turn *AgentTurn) *AgentResult {
	f.t.Helper()
	timeout := 120 * time.Second
	result, err := turn.Wait(f.ctx, AgentWaitOptions{Timeout: &timeout})
	if err != nil {
		f.t.Fatal(err)
	}
	if result.Status != AgentTurnCompleted {
		f.t.Fatalf("turn failed: %+v", result)
	}
	return result
}
func (f *goAgentVMFixture) get(a *Agent, id string) *AgentTurn {
	f.t.Helper()
	turn, err := a.GetTurn(f.ctx, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return turn
}
func (f *goAgentVMFixture) pid() string {
	f.t.Helper()
	pid := f.shell("sed -n 's/.*\"pid\":\\([0-9][0-9]*\\).*/\\1/p' " + goAgentServiceRecord)
	n, err := strconv.Atoi(pid)
	if err != nil || n <= 0 {
		f.t.Fatalf("invalid service pid %q", pid)
	}
	return pid
}
func (f *goAgentVMFixture) expectCreateError(code ErrorCode, message string) {
	f.t.Helper()
	a, err := f.box.Agents().Create(f.ctx, "opencode", AgentCreateOptions{Config: AgentConfig{Model: "fake/fake-model"}})
	checkAgentError(f.t, a, err, code)
	if !strings.Contains(err.Error(), message) {
		f.t.Fatalf("error %q lacks %q", err, message)
	}
}
func (f *goAgentVMFixture) restart() {
	f.t.Helper()
	id := f.box.ID()
	if err := f.box.Stop(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	f.box.Close()
	box, err := f.rt.Get(f.ctx, id)
	if err != nil {
		f.t.Fatal(err)
	}
	f.box = box
	if err := box.Start(f.ctx); err != nil {
		f.t.Fatal(err)
	}
}
func (f *goAgentVMFixture) install(name, path string) {
	f.t.Helper()
	if err := installVMTestAgent(f.box, name, path); err != nil {
		f.t.Fatal(err)
	}
}
func (f *goAgentVMFixture) delivered() {
	f.shell("rm /usr/local/bin/opencode")
	f.install("opencode", f.binary)
}
func (f *goAgentVMFixture) mounts() string {
	return f.shell(`awk '$2 == "/opt/boxlite/agents"' /proc/mounts | wc -l`)
}
func (f *goAgentVMFixture) completedAgentID() string {
	f.t.Helper()
	a := f.create()
	turn := f.send(a, "ping")
	f.wait(turn)
	return f.snapshot(turn).AgentID
}

func goAgentConcurrentCreate(f *goAgentVMFixture) {
	start := make(chan struct{})
	var wg sync.WaitGroup
	result := make(chan handleResult[*Agent], 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			a, e := f.box.Agents().Create(f.ctx, "opencode", AgentCreateOptions{Config: AgentConfig{Model: "fake/fake-model"}})
			result <- handleResult[*Agent]{value: a, err: e}
		}()
	}
	close(start)
	wg.Wait()
	close(result)
	var agents []*Agent
	for r := range result {
		if r.err != nil {
			f.t.Fatal(r.err)
		}
		agents = append(agents, r.value)
	}
	services := f.shell(`for p in /proc/[0-9]*; do case "$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null)" in *[o]pencode*serve*--service*) echo "${p#/proc/}";; esac; done`)
	if services != f.pid() {
		f.t.Fatalf("multiple services: %q", services)
	}
	for _, a := range agents {
		config, e := a.Config()
		if e != nil || config.Model != "fake/fake-model" {
			f.t.Fatalf("config=%+v %v", config, e)
		}
	}
	state, e := agents[0].State()
	checkAgentError(f.t, state, e, ErrUnsupported)
	events, e := agents[0].Events(f.ctx, AgentEventsOptions{})
	if e != nil {
		f.t.Fatal(e)
	}
	defer events.Close()
	turn := f.send(agents[0], "hello")
	resultValue := f.wait(turn)
	if resultValue.Text != "pong: hello" {
		f.t.Fatal(resultValue)
	}
	id := f.snapshot(turn).ID
	for {
		event, e := events.Next(f.ctx)
		if e != nil {
			f.t.Fatal(e)
		}
		if event.Kind == "session.inbox.enqueued" {
			if event.TurnID != id {
				f.t.Fatal(event)
			}
			adopted, e := f.box.Agents().Get(f.ctx, event.AgentID)
			if e != nil {
				f.t.Fatal(e)
			}
			if f.snapshot(f.get(adopted, id)).Status != AgentTurnCompleted {
				f.t.Fatal("adopted turn incomplete")
			}
			break
		}
	}
	runtime.KeepAlive(agents)
}
func goAgentHistoryPagination(f *goAgentVMFixture) {
	a := f.create()
	var ids []string
	for i := range 30 {
		ids = append(ids, f.snapshot(f.send(a, fmt.Sprintf("turn %d", i))).ID)
	}
	f.wait(f.get(a, ids[len(ids)-1]))
	if f.snapshot(f.get(a, ids[0])).Status != AgentTurnCompleted {
		f.t.Fatal("old turn not found beyond first page")
	}
}
func goAgentRunningRestart(f *goAgentVMFixture) {
	a := f.create()
	events, e := a.Events(f.ctx, AgentEventsOptions{})
	if e != nil {
		f.t.Fatal(e)
	}
	defer events.Close()
	running := f.snapshot(f.send(a, "SLOW please"))
	for {
		event, e := events.Next(f.ctx)
		if e != nil {
			f.t.Fatal(e)
		}
		if event.TurnID == running.ID && f.snapshot(f.get(a, running.ID)).Status == AgentTurnRunning {
			break
		}
	}
	queued := f.snapshot(f.send(a, "after the restart"))
	if queued.Status != AgentTurnQueued {
		f.t.Fatalf("expected queued turn: %+v", queued)
	}
	if status := f.snapshot(f.get(a, running.ID)).Status; status != AgentTurnRunning {
		f.t.Fatalf("turn before restart = %v, want running", status)
	}
	events.Close()
	f.restart()
	adopted, e := f.box.Agents().Get(f.ctx, running.AgentID)
	if e != nil {
		f.t.Fatal(e)
	}
	for _, id := range []string{running.ID, queued.ID} {
		f.wait(f.get(adopted, id))
	}
}
func goAgentForeignServer(f *goAgentVMFixture) {
	execution, e := f.box.StartExecution(f.ctx, "sh", []string{"-c", "OPENCODE_PASSWORD=foreign exec opencode serve --hostname 0.0.0.0 --port 47096 >/tmp/foreign.log 2>&1"}, nil)
	if e != nil {
		f.t.Fatal(e)
	}
	defer execution.Close()
	f.shell("for _ in $(seq 1 100); do grep -q listening /tmp/foreign.log && exit 0; sleep 0.2; done; exit 1")
	f.expectCreateError(ErrInvalidState, "held by another server")
}
func goAgentMissingBinary(f *goAgentVMFixture) {
	f.shell("rm /usr/local/bin/opencode")
	f.expectCreateError(ErrExecution, "must provide OpenCode 2.2.2")
}
func goAgentUserService(f *goAgentVMFixture) {
	url := f.shell("opencode service start 2>&1 | tail -n 1")
	pid := f.pid()
	f.t.Cleanup(func() { f.shell("kill -CONT " + pid) })
	for _, signal := range []string{"", "kill -STOP "} {
		if signal != "" {
			f.shell(signal + pid)
		}
		f.expectCreateError(ErrInvalidState, "runs at "+url)
	}
	f.shell("kill -CONT " + pid)
	if f.shell("opencode service status") != url || f.pid() != pid {
		f.t.Fatal("user service was replaced")
	}
}
func goAgentStaleRegistration(f *goAgentVMFixture) {
	f.shell("opencode service start >/dev/null 2>&1")
	dead := f.pid()
	f.shell("cp " + goAgentServiceRecord + " /root/stale.json && kill -9 " + dead)
	holder := f.shell("sleep 600 >/dev/null 2>&1 & echo $!")
	if _, e := strconv.Atoi(holder); e != nil {
		f.t.Fatal(e)
	}
	f.shell(fmt.Sprintf(`sed 's/"pid":%s/"pid":%s/' /root/stale.json > %s`, dead, holder, goAgentServiceRecord))
	a := f.create()
	if f.wait(f.send(a, "hello")).Text != "pong: hello" {
		f.t.Fatal("stale service was not recovered")
	}
	state := f.shell("sed -n 's/^State:[[:space:]]*//p' /proc/" + holder + "/status")
	if !strings.HasPrefix(state, "S") {
		f.t.Fatalf("unrelated process was signalled: %q", state)
	}
}
func goAgentPermissionBoundaries(f *goAgentVMFixture) {
	f.shell("mkdir -p /root/work && cd /root/work && for f in .env .env.local .env.example; do echo SECRET=1 > $f; done")
	a, e := f.box.Agents().Create(f.ctx, "opencode", AgentCreateOptions{Cwd: "/root/work", Config: AgentConfig{Model: "fake/fake-model"}})
	if e != nil {
		f.t.Fatal(e)
	}
	// The shared model echoes SECRET only when it actually receives it in a tool result.
	if text := f.wait(f.send(a, "READ .env.example")).Text; !strings.Contains(text, "SECRET") {
		f.t.Fatalf("allowed read=%q", text)
	}
	for _, file := range []string{".env", ".env.local"} {
		if text := f.wait(f.send(a, "READ "+file)).Text; strings.Contains(text, "SECRET") {
			f.t.Fatalf("denied read %s leaked: %q", file, text)
		}
	}
	f.wait(f.send(a, "ASK please"))
	if text := f.wait(f.send(a, "and then")).Text; text != "pong: and then" {
		f.t.Fatalf("question blocked later work: %q", text)
	}
}
func goAgentFrozenService(f *goAgentVMFixture) {
	f.create()
	pid := f.pid()
	f.shell("kill -STOP " + pid)
	f.t.Cleanup(func() { f.shell("kill -CONT " + pid) })
	f.expectCreateError(ErrInvalidState, "not responding")
	f.shell("kill -CONT " + pid)
	f.create()
	if f.pid() != pid {
		f.t.Fatal("frozen service was replaced")
	}
}
func goAgentRemoteService(f *goAgentVMFixture) {
	f.shell(`printf '{"remote":{"route":"test"}}' > /root/.config/opencode/service.json`)
	f.expectCreateError(ErrInvalidState, "remote access is on")
	if f.shell("test -e "+goAgentServiceRecord+" && echo registered || echo none") != "none" {
		f.t.Fatal("remote configuration started a local service")
	}
}
func goAgentInstalledBinary(f *goAgentVMFixture) {
	f.delivered()
	f.completedAgentID()
	if f.shell("command -v opencode || echo none") != "none" {
		f.t.Fatal("installation changed image PATH")
	}
	if out := f.shell("touch /opt/boxlite/agents/x 2>&1 && echo written || true"); !strings.Contains(out, "Read-only file system") {
		f.t.Fatal(out)
	}
}
func goAgentRepeatedInstall(f *goAgentVMFixture) {
	f.delivered()
	f.install("opencode", f.binary)
	f.create()
	if f.mounts() != "1" {
		f.t.Fatal("repeated install duplicated mount")
	}
}
func goAgentInstallAfterLookup(f *goAgentVMFixture) {
	f.delivered()
	if f.shell("stat /opt/boxlite/agents/probe >/dev/null 2>&1 || echo missing") != "missing" {
		f.t.Fatal("probe already exists")
	}
	probe := filepath.Join(f.t.TempDir(), "probe")
	if e := os.WriteFile(probe, []byte("#!/bin/sh\necho probe-ran\n"), 0700); e != nil {
		f.t.Fatal(e)
	}
	f.install("probe", probe)
	if f.shell("stat /opt/boxlite/agents/probe >/dev/null && /opt/boxlite/agents/probe/*/probe") != "probe-ran" {
		f.t.Fatal("negative lookup hid newly installed file")
	}
	if f.mounts() != "1" {
		f.t.Fatal("probe duplicated mount")
	}
}
func goAgentInstalledRestart(f *goAgentVMFixture) {
	f.delivered()
	id := f.completedAgentID()
	f.restart()
	if f.mounts() != "0" || f.shell("ls -A /opt/boxlite/agents") != "" {
		f.t.Fatal("mount survived stop")
	}
	a, e := f.box.Agents().Get(f.ctx, id)
	if e != nil {
		f.t.Fatal(e)
	}
	if f.mounts() != "1" {
		f.t.Fatal("first Go lookup did not restore mount")
	}
	f.wait(f.send(a, "ping"))
}
func goAgentMountRetry(f *goAgentVMFixture) {
	f.delivered()
	id := f.completedAgentID()
	f.restart()
	f.shell("touch /opt/boxlite/agents/blocker")
	a, e := f.box.Agents().Get(f.ctx, id)
	if a != nil || e == nil || !strings.Contains(e.Error(), "/opt/boxlite/agents") {
		f.t.Fatalf("mount error=%v %v", a, e)
	}
	if f.mounts() != "0" {
		f.t.Fatal("failed mount was installed")
	}
	info, e := f.box.Info(f.ctx)
	if e != nil || info.State != StateRunning {
		f.t.Fatalf("mount failure stopped VM: %+v %v", info, e)
	}
	f.shell("rm /opt/boxlite/agents/blocker")
	a, e = f.box.Agents().Get(f.ctx, id)
	if e != nil || a == nil {
		f.t.Fatal(e)
	}
	if f.mounts() != "1" {
		f.t.Fatal("mount retry did not succeed")
	}
}
