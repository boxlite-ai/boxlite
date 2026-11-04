package proc

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
)

var (
	sharedReaper     *Reaper
	sharedReaperOnce sync.Once
)

// testReaper returns the one reaper of the test process. Exactly one may
// exist: two Wait4(-1) loops would steal each other's exit statuses.
func testReaper(t *testing.T) *Reaper {
	t.Helper()
	sharedReaperOnce.Do(func() {
		sharedReaper = NewReaper()
		go sharedReaper.Run(context.Background())
	})
	return sharedReaper
}

// run is RunAs as the test process itself.
func run(ctx context.Context, r *Reaper, hub *logs.Hub, source string, deployment int, dir, command string, env []string) (int, error) {
	return RunAs(ctx, r, hub, source, deployment, dir, command, env, nil)
}

func baseEnv() []string {
	return []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func processGone(pid int) bool {
	// Kill(pid, 0) succeeds for live processes and zombies; ESRCH means reaped.
	return syscall.Kill(pid, 0) == syscall.ESRCH
}

func TestServiceRestartsCrashAndRecordsExitCode(t *testing.T) {
	hub := logs.NewHub()
	s := New(Config{Name: "crash", Command: "exit 3", Dir: t.TempDir(), Env: baseEnv(), Deployment: 9}, hub, testReaper(t))
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Stop(time.Second)

	waitFor(t, 5*time.Second, "first restart", func() bool {
		st := s.Status()
		return st.Restarts >= 1 && st.LastExitCode != nil && *st.LastExitCode == 3
	})
	st := s.Status()
	if st.State != api.StateRestarting && st.State != api.StateRunning {
		t.Fatalf("state = %s", st.State)
	}
	if st.Health != api.HealthNone || st.Port != nil {
		t.Fatalf("non-exposed service: %+v", st)
	}
	// Backoff grows: the second restart must not happen within the first second.
	time.Sleep(900 * time.Millisecond)
	if s.Status().Restarts > 2 {
		t.Fatalf("restarting too eagerly: %d restarts", s.Status().Restarts)
	}
	found := false
	for _, l := range hub.Tail(api.SourceSystem, 0) {
		if strings.Contains(l.Line, "service crash exited with code 3") && l.Level == api.LevelError && l.Deployment == 9 {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing system line about the crash: %v", logs.Lines(hub.Tail(api.SourceSystem, 0)))
	}
}

func TestServiceSignaledExitCode(t *testing.T) {
	s := New(Config{Name: "sig", Command: "kill -9 $$", Dir: t.TempDir(), Env: baseEnv()}, logs.NewHub(), testReaper(t))
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Stop(time.Second)
	waitFor(t, 5*time.Second, "SIGKILL exit code", func() bool {
		st := s.Status()
		return st.LastExitCode != nil && *st.LastExitCode == 137
	})
}

func TestServiceStopTerminatesGroup(t *testing.T) {
	// The leader spawns a grandchild; both must be gone after Stop.
	s := New(Config{Name: "grp", Command: "sleep 60 & echo child=$!; wait", Dir: t.TempDir(), Env: baseEnv()}, logs.NewHub(), testReaper(t))
	hub := s.hub
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	var child int
	waitFor(t, 5*time.Second, "grandchild pid", func() bool {
		for _, l := range hub.Tail("grp", 0) {
			if strings.HasPrefix(l.Line, "child=") {
				child, _ = strconv.Atoi(strings.TrimPrefix(l.Line, "child="))
			}
		}
		return child > 0
	})
	leader := *s.Status().PID
	start := time.Now()
	s.Stop(2 * time.Second)
	if time.Since(start) > 3*time.Second {
		t.Fatalf("Stop took %s", time.Since(start))
	}
	if st := s.Status(); st.State != api.StateStopped || st.PID != nil {
		t.Fatalf("after stop: %+v", st)
	}
	waitFor(t, 3*time.Second, "leader reaped", func() bool { return processGone(leader) })
	waitFor(t, 3*time.Second, "grandchild gone", func() bool { return syscall.Kill(child, 0) != nil })
}

func TestServiceStopEscalatesToSIGKILL(t *testing.T) {
	s := New(Config{Name: "stubborn", Command: "trap '' TERM; while true; do sleep 1; done", Dir: t.TempDir(), Env: baseEnv()}, logs.NewHub(), testReaper(t))
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // let the trap install
	start := time.Now()
	s.Stop(500 * time.Millisecond)
	if el := time.Since(start); el < 400*time.Millisecond || el > 4*time.Second {
		t.Fatalf("expected grace then SIGKILL, took %s", el)
	}
	if st := s.Status(); st.State != api.StateStopped {
		t.Fatalf("state = %s", st.State)
	}
}

func TestServiceLogsAndEnv(t *testing.T) {
	hub := logs.NewHub()
	env := append(baseEnv(), "BOXLITE_SERVICE=logtest", "PORT=12345")
	s := New(Config{Name: "logtest", Command: `echo "hello $BOXLITE_SERVICE on $PORT"; echo oops 1>&2; sleep 60`, Dir: t.TempDir(), Env: env, Deployment: 2}, hub, testReaper(t))
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Stop(time.Second)
	waitFor(t, 5*time.Second, "log lines", func() bool { return len(hub.Tail("logtest", 0)) >= 2 })
	var info, errLine bool
	for _, l := range hub.Tail("logtest", 0) {
		if l.Line == "hello logtest on 12345" && l.Level == api.LevelInfo && l.Deployment == 2 {
			info = true
		}
		if l.Line == "oops" && l.Level == api.LevelError {
			errLine = true
		}
	}
	if !info || !errLine {
		t.Fatalf("lines: %+v", hub.Tail("logtest", 0))
	}
}

func TestServiceHealthGate(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(200)
	}))
	defer ok.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer bad.Close()
	port := func(s *httptest.Server) int {
		u, _ := url.Parse(s.URL)
		p, _ := strconv.Atoi(u.Port())
		return p
	}

	// The probe targets PORT; here that is an httptest server standing in for
	// the app, so the gate logic is exercised without a real HTTP service.
	healthy := New(Config{Name: "web", Command: "sleep 60", Dir: t.TempDir(), Env: baseEnv(), Port: port(ok), Exposed: true, Health: "/healthz",
		HealthBudget: 3 * time.Second, HealthInterval: 30 * time.Millisecond}, logs.NewHub(), testReaper(t))
	if err := healthy.Start(); err != nil {
		t.Fatal(err)
	}
	defer healthy.Stop(time.Second)
	if st := healthy.Status(); st.State != api.StateStarting || st.Health != api.HealthStarting || st.Port == nil {
		t.Fatalf("right after start: %+v", st)
	}
	if !healthy.AwaitHealth(context.Background()) {
		t.Fatal("expected healthy")
	}
	if st := healthy.Status(); st.State != api.StateRunning || st.Health != api.HealthHealthy {
		t.Fatalf("after gate: %+v", st)
	}

	unhealthy := New(Config{Name: "web", Command: "sleep 60", Dir: t.TempDir(), Env: baseEnv(), Port: port(bad), Exposed: true, Health: "/",
		HealthBudget: 300 * time.Millisecond, HealthInterval: 30 * time.Millisecond}, logs.NewHub(), testReaper(t))
	if err := unhealthy.Start(); err != nil {
		t.Fatal(err)
	}
	defer unhealthy.Stop(time.Second)
	if unhealthy.AwaitHealth(context.Background()) {
		t.Fatal("expected unhealthy")
	}
	if st := unhealthy.Status(); st.State != api.StateRunning || st.Health != api.HealthUnhealthy {
		t.Fatalf("after failed gate: %+v", st)
	}
}

func TestServiceManualRestart(t *testing.T) {
	s := New(Config{Name: "r", Command: "sleep 60", Dir: t.TempDir(), Env: baseEnv()}, logs.NewHub(), testReaper(t))
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Stop(time.Second)
	first := *s.Status().PID
	s.Restart(2 * time.Second)
	waitFor(t, 5*time.Second, "new instance", func() bool {
		st := s.Status()
		return st.PID != nil && *st.PID != first && st.State == api.StateRunning
	})
	if st := s.Status(); st.Restarts != 0 || st.LastExitCode == nil {
		t.Fatalf("manual restart must not count as a crash: %+v", st)
	}
}

func TestServiceStartFailure(t *testing.T) {
	s := New(Config{Name: "nodir", Command: "true", Dir: "/nonexistent/dir", Env: baseEnv()}, logs.NewHub(), testReaper(t))
	if err := s.Start(); err == nil {
		t.Fatal("expected error for a missing working directory")
	}
	if st := s.Status(); st.State != api.StateFailed {
		t.Fatalf("state = %s", st.State)
	}
	s.Stop(time.Second) // must not hang
}

func TestStaticServiceHasNoProcess(t *testing.T) {
	s := New(Config{Name: "site", Static: true, Exposed: true}, logs.NewHub(), testReaper(t))
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	st := s.Status()
	if st.State != api.StateRunning || st.Health != api.HealthNone || st.PID != nil || st.Port != nil {
		t.Fatalf("static status: %+v", st)
	}
	if !s.AwaitHealth(context.Background()) {
		t.Fatal("static services pass the gate")
	}
	s.Stop(time.Second)
}

func TestRunBuildStep(t *testing.T) {
	hub := logs.NewHub()
	code, err := run(context.Background(), testReaper(t), hub, api.SourceBuild, 5, t.TempDir(), "echo out; echo err 1>&2; exit 4", baseEnv())
	if err != nil || code != 4 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	var out, errl bool
	for _, l := range hub.Tail(api.SourceBuild, 0) {
		if l.Line == "out" && l.Level == api.LevelInfo && l.Deployment == 5 {
			out = true
		}
		if l.Line == "err" && l.Level == api.LevelError {
			errl = true
		}
	}
	if !out || !errl {
		t.Fatalf("build lines: %+v", hub.Tail(api.SourceBuild, 0))
	}
}

func TestRunKillsStragglers(t *testing.T) {
	// A build step that leaves a background process holding stdout must still
	// return promptly, and the straggler must be killed.
	hub := logs.NewHub()
	start := time.Now()
	code, err := run(context.Background(), testReaper(t), hub, api.SourceBuild, 1, t.TempDir(), "sleep 60 & echo straggler=$!; exit 0", baseEnv())
	if err != nil || code != 0 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("Run hung on the straggler's pipe: %s", time.Since(start))
	}
	var pid int
	for _, l := range hub.Tail(api.SourceBuild, 0) {
		if strings.HasPrefix(l.Line, "straggler=") {
			pid, _ = strconv.Atoi(strings.TrimPrefix(l.Line, "straggler="))
		}
	}
	if pid == 0 {
		t.Fatal("no straggler pid logged")
	}
	waitFor(t, 3*time.Second, "straggler killed", func() bool { return syscall.Kill(pid, 0) != nil })
}

func TestRunCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := run(ctx, testReaper(t), logs.NewHub(), api.SourceBuild, 1, t.TempDir(), "sleep 60", baseEnv())
	if err == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("cancel should kill the build: err=%v after %s", err, time.Since(start))
	}
}

// TestMain doubles as a helper process: with SV_PROC_HELPER=escape the test
// binary moves itself into a process group of its own (as a daemonising
// build tool would) and sleeps, holding whatever stdout it inherited.
func TestMain(m *testing.M) {
	if os.Getenv("SV_PROC_HELPER") == "escape" {
		_ = syscall.Setpgid(0, 0)
		_ = os.WriteFile("escaped.ready", nil, 0o644) // in the build step's dir
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestRunReturnsWhenAnEscapedChildHoldsTheOutput(t *testing.T) {
	// The background job leaves the build step's process group, so the group
	// kill misses it and it keeps stdout open. RunAs must still return.
	prev := pumpDrain
	pumpDrain = 300 * time.Millisecond
	t.Cleanup(func() { pumpDrain = prev })
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	hub := logs.NewHub()
	start := time.Now()
	script := "SV_PROC_HELPER=escape '" + exe + "' & echo escaped=$!; while [ ! -e escaped.ready ]; do sleep 0.05; done; exit 0"
	code, err := run(context.Background(), testReaper(t), hub, api.SourceBuild, 1, t.TempDir(), script, baseEnv())
	var pid int
	for _, l := range hub.Tail(api.SourceBuild, 0) {
		if strings.HasPrefix(l.Line, "escaped=") {
			pid, _ = strconv.Atoi(strings.TrimPrefix(l.Line, "escaped="))
		}
	}
	if pid > 0 {
		t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	}
	if err != nil || code != 0 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if el := time.Since(start); el > 3*time.Second {
		t.Fatalf("RunAs waited %s for a pipe held outside the group", el)
	}
	if pid == 0 || syscall.Kill(pid, 0) != nil {
		t.Fatal("the background job did not outlive the group kill, so this test exercised nothing")
	}
}

func TestFreePortAlternates(t *testing.T) {
	a, err := FreePort()
	if err != nil {
		t.Fatal(err)
	}
	b, err := FreePort(a)
	if err != nil {
		t.Fatal(err)
	}
	if a == b || a < PortMin || a > PortMax || b < PortMin || b > PortMax {
		t.Fatalf("ports %d %d", a, b)
	}
}

// A service that exits before its first health answer must not pass the gate:
// the exit cancels the probe, and "no health result" is not "healthy".
func TestServiceThatExitsBeforeHealthFailsTheGate(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	free := l.Addr().(*net.TCPAddr).Port
	l.Close() // nothing answers on this port
	s := New(Config{Name: "web", Command: "exit 0", Dir: t.TempDir(), Env: baseEnv(), Port: free, Exposed: true, Health: "/healthz",
		HealthBudget: 3 * time.Second, HealthInterval: 30 * time.Millisecond}, logs.NewHub(), testReaper(t))
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Stop(time.Second)
	if s.AwaitHealth(context.Background()) {
		t.Fatalf("a service that exited before answering passed the health gate: %+v", s.Status())
	}
}

// A service that prints why it fails and exits at once: the deploy reads the log tail the moment
// the health gate fails (AwaitHealth returns), so that last line must already be in the log then.
func TestServiceExitIsRecordedAfterItsLastOutput(t *testing.T) {
	for i := 0; i < 30; i++ {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		free := l.Addr().(*net.TCPAddr).Port
		l.Close()
		hub := logs.NewHub()
		cmd := `i=0; while [ $i -lt 300 ]; do echo "starting $i"; i=$((i+1)); done; echo "Error: REPORT_REGION is not set" 1>&2; exit 1`
		s := New(Config{Name: "web", Command: cmd, Dir: t.TempDir(), Env: baseEnv(), Port: free, Exposed: true, Health: "/healthz",
			HealthBudget: 10 * time.Second, HealthInterval: 20 * time.Millisecond}, hub, testReaper(t))
		if err := s.Start(); err != nil {
			t.Fatal(err)
		}
		if s.AwaitHealth(context.Background()) {
			t.Fatal("a crashing service passed the health gate")
		}
		found := false
		for _, l := range hub.Tail("web", 0) {
			found = found || l.Line == "Error: REPORT_REGION is not set"
		}
		s.Stop(time.Second)
		if !found {
			t.Fatalf("run %d: the health gate failed before the service's last line was read", i)
		}
	}
}
