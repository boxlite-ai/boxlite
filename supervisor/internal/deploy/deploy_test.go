package deploy

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/cp"
	"github.com/boxlite-ai/microcloud/supervisor/internal/gateway"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
	"github.com/boxlite-ai/microcloud/supervisor/internal/proc"
	"github.com/boxlite-ai/microcloud/supervisor/internal/state"
)

const (
	token     = "bxt_test"
	secret    = "gw_test_secret"  // forward secret
	ctlSecret = "ctl_test_secret" // control secret
)

var (
	sharedReaper *proc.Reaper
	reaperOnce   sync.Once
)

// TestMain doubles as the test service: when SV_TEST_HELPER=http is set the
// test binary runs a tiny HTTP server on $PORT instead of the tests. This keeps
// the suite free of external tools (no python, no nc).
func TestMain(m *testing.M) {
	if os.Getenv("SV_TEST_HELPER") == "http" {
		helperServer()
		return
	}
	os.Exit(m.Run())
}

func helperServer() {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "hello from %s tag=%s db=%s", os.Getenv("BOXLITE_SERVICE"), os.Getenv("RELEASE_TAG"), os.Getenv("DATABASE_URL"))
	})
	fmt.Println("helper listening on", os.Getenv("PORT"))
	if err := http.ListenAndServe("127.0.0.1:"+os.Getenv("PORT"), mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// ---- fake control plane ----------------------------------------------------

type fakeCP struct {
	mu        sync.Mutex
	specs     map[int]api.SpecResponse
	current   int
	snapshots map[string][]byte
	statuses  []api.Status
	lines     []api.LogLine
	srv       *httptest.Server
}

func newFakeCP(t *testing.T, ln net.Listener) *fakeCP {
	t.Helper()
	f := &fakeCP{specs: map[int]api.SpecResponse{}, snapshots: map[string][]byte{}}
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(f.handle))
	if ln != nil {
		f.srv.Listener = ln
	}
	f.srv.Start()
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeCP) handle(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+token {
		http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/sv/v1/spec":
		spec, ok := f.specs[f.current]
		if !ok {
			http.Error(w, "no spec", http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(spec)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/sv/v1/snapshots/"):
		data, ok := f.snapshots[strings.TrimPrefix(r.URL.Path, "/sv/v1/snapshots/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Write(data)
	case r.Method == http.MethodPost && r.URL.Path == "/sv/v1/logs":
		var batch []api.LogLine
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.lines = append(f.lines, batch...)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && r.URL.Path == "/sv/v1/status":
		var st api.Status
		if err := json.NewDecoder(r.Body).Decode(&st); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.statuses = append(f.statuses, st)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeCP) set(spec api.SpecResponse, files map[string]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.specs[spec.Deployment] = spec
	f.current = spec.Deployment
	f.snapshots[spec.Snapshot.ID] = tarGz(files)
}

func (f *fakeCP) phases(deployment int) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, s := range f.statuses {
		if s.Deployment == deployment {
			out = append(out, s.Phase)
		}
	}
	return out
}

func (f *fakeCP) last(deployment int) api.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	var last api.Status
	for _, s := range f.statuses {
		if s.Deployment == deployment {
			last = s
		}
	}
	return last
}

func (f *fakeCP) waitPhase(t *testing.T, deployment int, phase string) api.Status {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		f.mu.Lock()
		for _, s := range f.statuses {
			if s.Deployment == deployment && s.Phase == phase {
				f.mu.Unlock()
				return s
			}
		}
		f.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("deployment #%d never reached %s; phases: %v", deployment, phase, f.phases(deployment))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func tarGz(files map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// ---- harness --------------------------------------------------------------------

type harness struct {
	t      *testing.T
	cp     *fakeCP
	client *cp.Client
	store  *state.Store
	hub    *logs.Hub
	reaper *proc.Reaper
	mgr    *Manager
	gw     *gateway.Server
	gwSrv  *httptest.Server
	cancel context.CancelFunc
}

func newHarness(t *testing.T, stateDir string, fake *fakeCP) *harness {
	t.Helper()
	// The services echo DATABASE_URL as given; this host's CA bundle must not change it.
	saved := caBundles
	caBundles = nil
	t.Cleanup(func() { caBundles = saved })
	client, err := cp.New(fake.srv.URL, token, false)
	if err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	shipper := cp.NewShipper(client)
	go shipper.Run(ctx)
	hub := logs.NewHub(shipper.Emit)
	// One reaper per process, as in production: two Wait4(-1) loops would
	// steal each other's exit statuses.
	reaperOnce.Do(func() {
		sharedReaper = proc.NewReaper()
		go sharedReaper.Run(context.Background())
	})
	reaper := sharedReaper

	mgr := New(Options{
		CP: client, Hub: hub, Store: store, Reaper: reaper, Version: "test",
		HealthBudget: 3 * time.Second, HealthInterval: 30 * time.Millisecond, SettleWindow: 400 * time.Millisecond,
		StopGrace: time.Second, SpecRetry: 150 * time.Millisecond, Keep: 3,
		BaseEnv: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")},
	})
	gw := gateway.New(mgr, false)
	mgr.SetGate(gw)
	gwSrv := httptest.NewServer(gw)
	h := &harness{t: t, cp: fake, client: client, store: store, hub: hub, reaper: reaper, mgr: mgr, gw: gw, gwSrv: gwSrv, cancel: cancel}
	t.Cleanup(func() {
		mgr.Shutdown()
		gwSrv.Close()
		cancel()
	})
	return h
}

func (h *harness) spec(n int, tag string, build []string, services []api.Service) api.SpecResponse {
	return api.SpecResponse{
		Spec: api.Spec{App: "demo", Environment: "main", Version: n, Deployment: n,
			Runtime: api.Runtime{Image: "node", Size: "small", Build: build}, Services: services},
		Deployment:    n,
		ForwardSecret: secret,
		ControlSecret: ctlSecret,
		Env:           map[string]string{"SV_TEST_HELPER": "http", "RELEASE_TAG": tag, "DATABASE_URL": "postgres://db/" + tag},
		Snapshot:      api.Snapshot{ID: fmt.Sprintf("snap_%d", n)},
	}
}

func helperServices() []api.Service {
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return []api.Service{
		{Name: "web", Command: "exec '" + exe + "'", Port: api.PortHint{Exposed: true, Hint: 3000}, Health: "/healthz"},
		{Name: "worker", Command: "while true; do sleep 1; done"},
	}
}

func (h *harness) call(method, path, body string) (int, map[string]any, string) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.gwSrv.URL+path, strings.NewReader(body))
	if strings.HasPrefix(path, "/.boxlite/sv/") {
		req.Header.Set(gateway.ControlHeader, ctlSecret)
	} else {
		req.Header.Set(gateway.SecretHeader, secret)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var parsed map[string]any
	_ = json.Unmarshal(raw, &parsed)
	return resp.StatusCode, parsed, string(raw)
}

func (h *harness) deploymentCall(path string, n int) (int, map[string]any) {
	code, body, _ := h.call(http.MethodPost, "/.boxlite/sv/"+path, fmt.Sprintf(`{"deployment":%d}`, n))
	return code, body
}

func (h *harness) health() api.HealthResponse {
	h.t.Helper()
	_, _, raw := h.call(http.MethodGet, "/.boxlite/sv/health", "")
	var hr api.HealthResponse
	if err := json.Unmarshal([]byte(raw), &hr); err != nil {
		h.t.Fatalf("health: %v: %s", err, raw)
	}
	return hr
}

func (h *harness) service(hr api.HealthResponse, name string) api.ServiceStatus {
	for _, s := range hr.Services {
		if s.Name == name {
			return s
		}
	}
	h.t.Fatalf("service %s not in %+v", name, hr.Services)
	return api.ServiceStatus{}
}

func (h *harness) body(path string) string {
	code, _, raw := h.call(http.MethodGet, path, "")
	if code != 200 {
		h.t.Fatalf("GET %s: %d %s", path, code, raw)
	}
	return raw
}

func currentLink(t *testing.T, store *state.Store) string {
	t.Helper()
	target, err := os.Readlink(store.CurrentLink())
	if err != nil {
		t.Fatalf("current symlink: %v", err)
	}
	return target
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// ---- the scenario ------------------------------------------------------------

func TestDeployActivateRollbackLifecycle(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)

	// Before the first spec fetch the gateway has no secret: nothing can get in.
	if code, body, _ := h.call(http.MethodGet, "/.boxlite/sv/health", ""); code != 403 || body["error"] != "gateway" {
		t.Fatalf("fresh gateway must refuse everything: %d %v", code, body)
	}

	// --- #1 arrives through boot (2.4 step 6): nothing on disk, the spec names
	// #1, so the supervisor builds and activates it back to back.
	fake.set(h.spec(1, "one", []string{"echo built > built.txt", "echo build-out; echo build-err 1>&2"}, helperServices()),
		map[string]string{"README.md": "one"})
	h.mgr.Boot(context.Background())
	live := fake.waitPhase(t, 1, api.PhaseLive)
	h.mgr.Wait()
	if got := fake.phases(1); strings.Join(got, ",") != "building,built,starting,live" {
		t.Fatalf("phases #1 = %v", got)
	}
	if b, err := os.ReadFile(filepath.Join(h.store.ReleaseDir(1), "built.txt")); err != nil || strings.TrimSpace(string(b)) != "built" {
		t.Fatalf("build step did not run in the release dir: %q %v", b, err)
	}
	waitUntil(t, "build lines shipped", func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		var out, errl bool
		for _, l := range fake.lines {
			if l.Source == api.SourceBuild && l.Deployment == 1 && l.Line == "build-out" && l.Level == api.LevelInfo {
				out = true
			}
			if l.Source == api.SourceBuild && l.Deployment == 1 && l.Line == "build-err" && l.Level == api.LevelError {
				errl = true
			}
		}
		return out && errl
	})

	hr := h.health()
	if !hr.OK || hr.Deployment != 1 || hr.SpecVersion != 1 {
		t.Fatalf("health after activate: %+v", hr)
	}
	web := h.service(hr, "web")
	if web.State != api.StateRunning || web.Health != api.HealthHealthy || web.Port == nil || *web.Port < proc.PortMin || *web.Port > proc.PortMax || web.PID == nil {
		t.Fatalf("web: %+v", web)
	}
	if worker := h.service(hr, "worker"); worker.State != api.StateRunning || worker.Health != api.HealthNone || worker.Port != nil {
		t.Fatalf("worker: %+v", worker)
	}
	if len(live.Services) != 2 {
		t.Fatalf("live status carries services: %+v", live)
	}
	if got := h.body("/"); got != "hello from web tag=one db=postgres://db/one" {
		t.Fatalf("proxied body: %q", got)
	}
	if currentLink(t, h.store) != "releases/1" || h.store.Get().Current != 1 {
		t.Fatalf("current not updated: %s %+v", currentLink(t, h.store), h.store.Get())
	}
	port1 := *web.Port
	pid1 := *web.PID

	// --- deploy + activate #2 explicitly: ports alternate, old instances stop ---
	fake.set(h.spec(2, "two", nil, helperServices()), map[string]string{"README.md": "two"})
	if code, body := h.deploymentCall("activate", 2); code != 409 || body["error"] != "not_built" {
		t.Fatalf("activate before build: %d %v", code, body)
	}
	if code, _ := h.deploymentCall("deploy", 2); code != 202 {
		t.Fatal("deploy #2")
	}
	fake.waitPhase(t, 2, api.PhaseBuilt)
	h.mgr.Wait()
	if got := fake.phases(2); strings.Join(got, ",") != "building,built" {
		t.Fatalf("deploy must stop at built: %v", got)
	}
	if h.body("/") != "hello from web tag=one db=postgres://db/one" || h.health().Deployment != 1 {
		t.Fatal("old release must keep serving while #2 is only built")
	}
	if code, _ := h.deploymentCall("activate", 2); code != 202 {
		t.Fatal("activate #2")
	}
	fake.waitPhase(t, 2, api.PhaseLive)
	h.mgr.Wait()
	hr = h.health()
	web = h.service(hr, "web")
	if hr.Deployment != 2 || *web.Port == port1 {
		t.Fatalf("#2 must use a different port than #1 (%d): %+v", port1, web)
	}
	if got := h.body("/"); got != "hello from web tag=two db=postgres://db/two" {
		t.Fatalf("after #2: %q", got)
	}
	waitUntil(t, "old web stopped", func() bool { return syscall.Kill(pid1, 0) == syscall.ESRCH })
	if currentLink(t, h.store) != "releases/2" {
		t.Fatal("current → releases/2")
	}

	// --- deploy #3: build fails; #2 stays live, dir is cleaned, activate → 409 ---
	fake.set(h.spec(3, "three", []string{"echo compiling; exit 7"}, helperServices()), map[string]string{"README.md": "three"})
	if code, _ := h.deploymentCall("deploy", 3); code != 202 {
		t.Fatal("deploy #3")
	}
	failed := fake.waitPhase(t, 3, api.PhaseFailed)
	h.mgr.Wait()
	if failed.Step != "build" || !strings.Contains(failed.Error, "code 7") || len(failed.LogTail) == 0 || failed.LogTail[len(failed.LogTail)-1] != "compiling" {
		t.Fatalf("failed status: %+v", failed)
	}
	if got := h.body("/"); got != "hello from web tag=two db=postgres://db/two" {
		t.Fatalf("#2 must stay live after a failed build: %q", got)
	}
	if _, err := os.Stat(h.store.ReleaseDir(3)); !os.IsNotExist(err) {
		t.Fatal("failed build dir should be removed")
	}
	if code, body := h.deploymentCall("activate", 3); code != 409 || body["error"] != "not_built" {
		t.Fatalf("activate failed build: %d %v", code, body)
	}

	// --- deploy + activate #4: web never listens → health gate fails, #2 stays ---
	broken := helperServices()
	broken[0].Command = "sleep 60"
	fake.set(h.spec(4, "four", nil, broken), map[string]string{"README.md": "four"})
	h.deploymentCall("deploy", 4)
	fake.waitPhase(t, 4, api.PhaseBuilt)
	h.mgr.Wait()
	h.deploymentCall("activate", 4)
	failed = fake.waitPhase(t, 4, api.PhaseFailed)
	h.mgr.Wait()
	if failed.Step != "start" || !strings.Contains(failed.Error, "health") {
		t.Fatalf("health gate failure: %+v", failed)
	}
	if got := h.body("/"); got != "hello from web tag=two db=postgres://db/two" {
		t.Fatalf("#2 must stay live after a failed start: %q", got)
	}
	if hr := h.health(); hr.Deployment != 2 || len(hr.Services) != 2 || h.service(hr, "web").State != api.StateRunning {
		t.Fatalf("health after failed #4: %+v", hr)
	}
	if currentLink(t, h.store) != "releases/2" {
		t.Fatal("current must still be releases/2")
	}

	// --- rollback to #1 with a fresh env from the control plane ---
	fake.mu.Lock()
	s4 := fake.specs[4]
	s4.Env["DATABASE_URL"] = "postgres://db/migrated"
	fake.specs[4] = s4
	fake.mu.Unlock()
	if code, body := h.deploymentCall("rollback", 42); code != 404 || body["error"] != "not_found_release" {
		t.Fatalf("rollback unknown: %d %v", code, body)
	}
	if code, _ := h.deploymentCall("rollback", 1); code != 202 {
		t.Fatal("rollback #1")
	}
	fake.waitPhase(t, 1, api.PhaseLive)
	h.mgr.Wait()
	if got := h.body("/"); got != "hello from web tag=four db=postgres://db/migrated" {
		t.Fatalf("rollback must run release #1 with the control plane's current env: %q", got)
	}
	if currentLink(t, h.store) != "releases/1" || h.health().Deployment != 1 {
		t.Fatal("current → releases/1")
	}

	// --- deploy + activate #5 prunes beyond the newest 3 (never the current) ---
	fake.set(h.spec(5, "five", nil, helperServices()), map[string]string{"README.md": "five"})
	h.deploymentCall("deploy", 5)
	fake.waitPhase(t, 5, api.PhaseBuilt)
	h.mgr.Wait()
	h.deploymentCall("activate", 5)
	fake.waitPhase(t, 5, api.PhaseLive)
	h.mgr.Wait()
	// On disk before prune: 1, 2, 4, 5 → keep 2, 4, 5; 1 is no longer current → pruned.
	if _, err := os.Stat(h.store.ReleaseDir(1)); !os.IsNotExist(err) {
		t.Fatal("release 1 should have been pruned")
	}
	if st := h.store.Get(); st.Release(1) != nil || st.Release(2) == nil || st.Release(5) == nil || st.Current != 5 {
		t.Fatalf("state after prune: %+v", st)
	}

	// --- concurrency: a second deploy/activate during a build → 409 ---
	fake.set(h.spec(6, "six", []string{"sleep 1.5"}, helperServices()), map[string]string{"README.md": "six"})
	if code, _ := h.deploymentCall("deploy", 6); code != 202 {
		t.Fatal("deploy #6")
	}
	if code, body := h.deploymentCall("deploy", 6); code != 409 || body["error"] != "deploy_in_progress" {
		t.Fatalf("concurrent deploy: %d %v", code, body)
	}
	if code, _ := h.deploymentCall("activate", 5); code != 409 {
		t.Fatalf("activate during build: %d", code)
	}
	if code, _ := h.deploymentCall("rollback", 2); code != 409 {
		t.Fatalf("rollback during build: %d", code)
	}
	fake.waitPhase(t, 6, api.PhaseBuilt)
	h.mgr.Wait()
	// Deploying an already-built release is a no-op that re-reports built.
	if code, _ := h.deploymentCall("deploy", 6); code != 202 {
		t.Fatal("re-deploy built #6")
	}
	h.mgr.Wait()
	if got := fake.phases(6); strings.Join(got, ",") != "building,built,built" {
		t.Fatalf("phases #6 = %v", got)
	}

	// --- restart ---
	hr = h.health()
	pidBefore := *h.service(hr, "web").PID
	if code, _, raw := h.call(http.MethodPost, "/.boxlite/sv/restart", `{"service":"web"}`); code != 200 {
		t.Fatalf("restart web: %d %s", code, raw)
	}
	waitUntil(t, "web restarted", func() bool {
		s := h.service(h.health(), "web")
		return s.PID != nil && *s.PID != pidBefore && s.Health == api.HealthHealthy
	})
	if s := h.service(h.health(), "web"); s.Restarts != 0 {
		t.Fatalf("manual restart counted as crash: %+v", s)
	}
	if got := h.body("/"); got != "hello from web tag=five db=postgres://db/five" {
		t.Fatalf("after restart: %q", got)
	}
	if code, _, _ := h.call(http.MethodPost, "/.boxlite/sv/restart", `{"service":"nope"}`); code != 404 {
		t.Fatalf("restart unknown service: %d", code)
	}
	if code, _, _ := h.call(http.MethodPost, "/.boxlite/sv/restart", `{"service":null}`); code != 200 {
		t.Fatalf("restart all: %d", code)
	}

	// --- local log ring via the gateway ---
	_, body, _ := h.call(http.MethodGet, "/.boxlite/sv/logs?source=build&tail=3", "")
	lines, _ := body["lines"].([]any)
	if len(lines) == 0 || len(lines) > 3 {
		t.Fatalf("logs tail: %v", body)
	}
	// The system ring has the story of every deployment, each line tagged
	// with the deployment it belongs to (what the text says is not the
	// contract; the attribution is).
	_, body, _ = h.call(http.MethodGet, "/.boxlite/sv/logs?source=system&tail=2000", "")
	perDeployment := map[float64]int{}
	for _, l := range body["lines"].([]any) {
		m := l.(map[string]any)
		if m["source"] != api.SourceSystem {
			t.Fatalf("source=system returned %v", m)
		}
		if d, ok := m["deployment"].(float64); ok {
			perDeployment[d]++
		}
	}
	for _, n := range []float64{1, 2, 3, 4, 5, 6} {
		if perDeployment[n] == 0 {
			t.Fatalf("no system lines for deployment #%v: %v", n, perDeployment)
		}
	}

	// --- shutdown stops everything ---
	hr = h.health()
	pids := []int{*h.service(hr, "web").PID, *h.service(hr, "worker").PID}
	h.mgr.Shutdown()
	for _, pid := range pids {
		waitUntil(t, fmt.Sprintf("pid %d gone", pid), func() bool { return syscall.Kill(pid, 0) == syscall.ESRCH })
	}
}

// A release whose web answers its health check but whose worker dies right away
// must not go live: one good health answer does not make a healthy release.
func TestCrashingWorkerNeverGoesLive(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)

	fake.set(h.spec(1, "one", nil, helperServices()), map[string]string{"README.md": "one"})
	h.mgr.Boot(context.Background())
	fake.waitPhase(t, 1, api.PhaseLive)
	h.mgr.Wait()

	crashing := helperServices()
	crashing[1].Command = "sleep 0.1; exit 4"
	fake.set(h.spec(2, "two", nil, crashing), map[string]string{"README.md": "two"})
	h.deploymentCall("deploy", 2)
	fake.waitPhase(t, 2, api.PhaseBuilt)
	h.mgr.Wait()
	h.deploymentCall("activate", 2)
	failed := fake.waitPhase(t, 2, api.PhaseFailed)
	h.mgr.Wait()
	if failed.Step != "start" || !strings.Contains(failed.Error, "worker exited with code 4") {
		t.Fatalf("crashing worker must fail the start step: %+v", failed)
	}
	if hr := h.health(); hr.Deployment != 1 {
		t.Fatalf("#1 must stay live, got %+v", hr)
	}
}

func TestStaticRelease(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)

	services := []api.Service{{Name: "site", Static: "dist/"}}
	fake.set(h.spec(1, "static", []string{"mkdir -p dist && cp src/* dist/"}, services),
		map[string]string{"src/index.html": "<h1>site</h1>", "src/app.js": "var x=1"})
	h.mgr.Boot(context.Background())
	fake.waitPhase(t, 1, api.PhaseLive)
	h.mgr.Wait()

	hr := h.health()
	site := h.service(hr, "site")
	if !hr.OK || site.State != api.StateRunning || site.Health != api.HealthNone || site.PID != nil || site.Port != nil {
		t.Fatalf("static health: %+v", hr)
	}
	if got := h.body("/"); got != "<h1>site</h1>" {
		t.Fatalf("index: %q", got)
	}
	if got := h.body("/some/route"); got != "<h1>site</h1>" {
		t.Fatalf("SPA fallback: %q", got)
	}
	if got := h.body("/app.js"); got != "var x=1" {
		t.Fatalf("asset: %q", got)
	}
	if code, _, _ := h.call(http.MethodGet, "/nope.png", ""); code != 404 {
		t.Fatalf("missing asset: %d", code)
	}

	// A static release whose directory the build did not produce fails at start.
	fake.set(h.spec(2, "static2", nil, services), map[string]string{"README.md": "no dist"})
	h.deploymentCall("deploy", 2)
	fake.waitPhase(t, 2, api.PhaseBuilt)
	h.mgr.Wait()
	h.deploymentCall("activate", 2)
	failed := fake.waitPhase(t, 2, api.PhaseFailed)
	h.mgr.Wait()
	if failed.Step != "start" || !strings.Contains(failed.Error, "dist/") {
		t.Fatalf("missing static dir: %+v", failed)
	}
	if got := h.body("/"); got != "<h1>site</h1>" {
		t.Fatal("release 1 must still serve")
	}
}

func TestBootWithoutControlPlaneThenReconcile(t *testing.T) {
	stateDir := t.TempDir()

	// Phase 1: a normal deploy so state.json and releases/1 exist.
	fake := newFakeCP(t, nil)
	h := newHarness(t, stateDir, fake)
	fake.set(h.spec(1, "one", nil, helperServices()), map[string]string{"README.md": "one"})
	h.mgr.Boot(context.Background())
	fake.waitPhase(t, 1, api.PhaseLive)
	h.mgr.Wait()
	h.mgr.Shutdown()
	h.gwSrv.Close()
	h.cancel()
	addr := fake.srv.Listener.Addr().String()
	fake.srv.Close()

	// Phase 2: "box wake" with the control plane down. The release must come
	// back from disk, the gateway secret from state.json.
	down := &fakeCP{srv: &httptest.Server{URL: "http://" + addr}}
	h2 := newHarness(t, stateDir, down)
	h2.mgr.Boot(context.Background())
	waitUntil(t, "release restored at boot", func() bool { return h2.health().OK && h2.health().Deployment == 1 })
	waitUntil(t, "web healthy after boot", func() bool { return h2.service(h2.health(), "web").Health == api.HealthHealthy })
	if got := h2.body("/"); got != "hello from web tag=one db=postgres://db/one" {
		t.Fatalf("boot without CP: %q", got)
	}

	// Phase 3: the control plane comes back on the same address naming #2.
	// The reconcile loop must build and activate it back to back.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("could not rebind %s: %v", addr, err)
	}
	back := newFakeCP(t, ln)
	back.set(h2.spec(2, "two", []string{"echo rebuilt"}, helperServices()), map[string]string{"README.md": "two"})
	back.waitPhase(t, 2, api.PhaseLive)
	h2.mgr.Wait()
	if got := back.phases(2); strings.Join(got, ",") != "building,built,starting,live" {
		t.Fatalf("reconcile phases: %v", got)
	}
	if got := h2.body("/"); got != "hello from web tag=two db=postgres://db/two" {
		t.Fatalf("after reconcile: %q", got)
	}
	if h2.store.Get().Current != 2 || currentLink(t, h2.store) != "releases/2" {
		t.Fatal("current → releases/2")
	}

	// Phase 4: boot again with the control plane naming the current deployment:
	// nothing is rebuilt, but `live` is reported.
	h2.mgr.Shutdown()
	h2.cancel()
	h2.gwSrv.Close()
	h3 := newHarness(t, stateDir, back)
	before := len(back.phases(2))
	h3.mgr.Boot(context.Background())
	h3.mgr.Wait()
	waitUntil(t, "boot reports live", func() bool { return back.last(2).Phase == api.PhaseLive && len(back.phases(2)) == before+1 })
	// Right after boot the app may not have bound its port yet: the gateway
	// answers 503 + Retry-After until the exposed service is up.
	if code, body, _ := h3.call(http.MethodGet, "/", ""); code != 200 && (code != 503 || body["error"] != "service_unavailable") {
		t.Fatalf("during startup: %d %v", code, body)
	}
	waitUntil(t, "web healthy after reboot", func() bool { return h3.service(h3.health(), "web").Health == api.HealthHealthy })
	if got := h3.body("/"); got != "hello from web tag=two db=postgres://db/two" {
		t.Fatalf("after reboot: %q", got)
	}
}

// What the build installed runs by its bare name, and the platform's
// DATABASE_URL names the system CA bundle (no other connection is touched).
func TestServiceEnvToolPathsAndCA(t *testing.T) {
	ca := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(ca, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	saved := caBundles
	caBundles = []string{"/nonexistent/ca.crt", ca}
	t.Cleanup(func() { caBundles = saved })
	m := New(Options{BaseEnv: []string{"PATH=/usr/bin:/bin"}, RunAs: &proc.Cred{Home: "/home/boxlite", Name: "boxlite"}})
	rel := state.Release{Deployment: 4, Env: map[string]string{"DATABASE_URL": "postgresql://u:p@db/neondb?sslmode=verify-full"}}
	env := strings.Join(m.serviceEnv(rel, "/rel/4", "web", 0), "\n")
	for _, want := range []string{"PATH=/rel/4/node_modules/.bin:/home/boxlite/.local/bin:/usr/bin:/bin", "DATABASE_URL=postgresql://u:p@db/neondb?sslmode=verify-full&sslrootcert=" + url.QueryEscape(ca)} {
		if !strings.Contains(env, want) {
			t.Fatalf("missing %s in\n%s", want, env)
		}
	}
	if strings.Contains(env, "PGSSLROOTCERT") {
		t.Fatal("PGSSLROOTCERT would change every other Postgres connection of the app")
	}
	own := withRootCert("postgresql://x/db?sslrootcert=/app/ca.pem")
	if own != "postgresql://x/db?sslrootcert=/app/ca.pem" {
		t.Fatalf("an explicit sslrootcert must stay: %s", own)
	}
}

func TestServiceEnvComposition(t *testing.T) {
	m := New(Options{BaseEnv: []string{"PATH=/bin", "PORT=9", "HOME=/h"}})
	rel := state.Release{Deployment: 3, Spec: api.Spec{Environment: "staging"}, Env: map[string]string{"DATABASE_URL": "x", "HOME": "/override"}}
	got := strings.Join(m.serviceEnv(rel, "/r/3", "web", 20001), "\n")
	for _, want := range []string{"BOXLITE_ENV=staging", "BOXLITE_SERVICE=web", "DATABASE_URL=x", "HOME=/override", "PATH=/r/3/node_modules/.bin:/h/.local/bin:/bin", "PORT=20001"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %s in\n%s", want, got)
		}
	}
	if strings.Contains(got, "PORT=9") {
		t.Fatal("inherited PORT must not leak")
	}
	build := strings.Join(m.serviceEnv(rel, "/r/3", "", 0), "\n")
	if strings.Contains(build, "PORT=") || strings.Contains(build, "BOXLITE_SERVICE=") {
		t.Fatalf("build env must have no PORT/BOXLITE_SERVICE:\n%s", build)
	}
}

// fakeCP.stallSnapshots makes every snapshot download send its headers and a
// few bytes, then go silent until the test ends.
func (f *fakeCP) stallSnapshots(t *testing.T) {
	t.Helper()
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	inner := f.srv.Config.Handler
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/sv/v1/snapshots/") {
			inner.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Write([]byte{0x1f, 0x8b})
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
}

// A snapshot download that stops sending must fail the deploy quickly and
// free the deploy slot, instead of answering 409 to every later deploy.
func TestStalledSnapshotDownloadFreesTheDeploySlot(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)
	h.client.SnapshotStall = 300 * time.Millisecond
	h.gw.SetSecrets(secret, ctlSecret)

	fake.set(h.spec(1, "one", nil, helperServices()), map[string]string{"README.md": "one"})
	fake.stallSnapshots(t)
	start := time.Now()
	if code, body := h.deploymentCall("deploy", 1); code != 202 {
		t.Fatalf("deploy #1: %d %v", code, body)
	}
	failed := fake.waitPhase(t, 1, api.PhaseFailed)
	h.mgr.Wait()
	if failed.Step != "download" || !strings.Contains(failed.Error, "stalled") || time.Since(start) > 5*time.Second {
		t.Fatalf("stalled download: %+v after %s", failed, time.Since(start))
	}
	if _, err := os.Stat(h.store.ReleaseDir(1)); !os.IsNotExist(err) {
		t.Fatal("a failed download must leave no release dir behind")
	}
	if code, body := h.deploymentCall("deploy", 1); code != 202 {
		t.Fatalf("the next deploy must be accepted, not 409: %d %v", code, body)
	}
	h.mgr.Wait()
}

// The whole build (download included) shares BuildTimeout.
func TestBuildTimeoutCoversTheDownload(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)
	h.mgr.o.BuildTimeout = 400 * time.Millisecond
	h.client.SnapshotStall = time.Minute // the stall timer must not be what ends it
	h.gw.SetSecrets(secret, ctlSecret)
	fake.set(h.spec(1, "one", nil, helperServices()), map[string]string{"README.md": "one"})
	fake.stallSnapshots(t)
	h.deploymentCall("deploy", 1)
	failed := fake.waitPhase(t, 1, api.PhaseFailed)
	h.mgr.Wait()
	if failed.Step != "download" || !strings.Contains(failed.Error, "timed out") {
		t.Fatalf("download past the build deadline: %+v", failed)
	}
}

// SIGTERM (Shutdown) during a build kills the build step's whole process
// group, reports the deployment failed, and leaves the live release alone
// until Shutdown stops it.
func TestShutdownCancelsARunningBuild(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)
	fake.set(h.spec(1, "one", nil, helperServices()), map[string]string{"README.md": "one"})
	h.mgr.Boot(context.Background())
	fake.waitPhase(t, 1, api.PhaseLive)
	h.mgr.Wait()
	livePID := *h.service(h.health(), "web").PID

	fake.set(h.spec(2, "two", []string{"sleep 60 & echo child=$! > child.pid; wait"}, helperServices()), map[string]string{"README.md": "two"})
	if code, _ := h.deploymentCall("deploy", 2); code != 202 {
		t.Fatal("deploy #2")
	}
	var child int
	waitUntil(t, "build step running", func() bool {
		b, err := os.ReadFile(filepath.Join(h.store.ReleaseDir(2), "child.pid"))
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(string(b), "child=%d", &child)
		return err == nil && child > 0
	})

	start := time.Now()
	h.mgr.Shutdown()
	if el := time.Since(start); el > 8*time.Second {
		t.Fatalf("Shutdown took %s with a build running", el)
	}
	failed := fake.waitPhase(t, 2, api.PhaseFailed)
	if failed.Step != "build" || !strings.Contains(failed.Error, "shutting down") {
		t.Fatalf("cancelled build: %+v", failed)
	}
	waitUntil(t, "build step's child killed", func() bool { return syscall.Kill(child, 0) == syscall.ESRCH })
	waitUntil(t, "live release stopped by Shutdown", func() bool { return syscall.Kill(livePID, 0) == syscall.ESRCH })
	if code, body := h.deploymentCall("deploy", 2); code != 503 || body["error"] != "shutting_down" {
		t.Fatalf("deploy after shutdown: %d %v", code, body)
	}
}

// SIGTERM during an activation stops the candidate and never flips to it.
func TestShutdownCancelsAnActivation(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)
	h.mgr.o.HealthBudget = 30 * time.Second
	h.gw.SetSecrets(secret, ctlSecret)
	never := helperServices()
	never[0].Command = "echo $$ > web.pid; exec sleep 60" // never becomes healthy
	fake.set(h.spec(1, "one", nil, never), map[string]string{"README.md": "one"})
	h.deploymentCall("deploy", 1)
	fake.waitPhase(t, 1, api.PhaseBuilt)
	h.mgr.Wait()
	h.deploymentCall("activate", 1)
	fake.waitPhase(t, 1, api.PhaseStarting)
	var web int
	waitUntil(t, "candidate started", func() bool {
		b, err := os.ReadFile(filepath.Join(h.store.ReleaseDir(1), "web.pid"))
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(string(b), "%d", &web)
		return err == nil && web > 0
	})

	start := time.Now()
	h.mgr.Shutdown()
	if el := time.Since(start); el > 8*time.Second {
		t.Fatalf("Shutdown took %s during an activation", el)
	}
	failed := fake.waitPhase(t, 1, api.PhaseFailed)
	if failed.Step != "start" || !strings.Contains(failed.Error, "shutting down") {
		t.Fatalf("cancelled activation: %+v", failed)
	}
	if hr := h.mgr.Health(); hr.OK || hr.Deployment != 0 {
		t.Fatalf("the cancelled candidate must never go live: %+v", hr)
	}
	waitUntil(t, "candidate stopped", func() bool { return syscall.Kill(web, 0) == syscall.ESRCH })
}

// Cancelling Boot's context ends the reconcile loop that would otherwise
// poll an unreachable control plane forever.
func TestBootContextEndsTheReconcileLoop(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)
	fake.srv.Close() // unreachable
	ctx, cancel := context.WithCancel(context.Background())
	h.mgr.Boot(ctx)
	time.Sleep(200 * time.Millisecond)
	cancel()
	done := make(chan struct{})
	go func() { h.mgr.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the reconcile loop ignored the cancelled context")
	}
}

// A web service that exits before it answers fails the start step with what
// happened (it exited, and how), not with a health-check timeout.
func TestWebThatExitsBeforeAnsweringFailsWithItsExit(t *testing.T) {
	fake := newFakeCP(t, nil)
	h := newHarness(t, t.TempDir(), fake)

	fake.set(h.spec(1, "one", nil, helperServices()), map[string]string{"README.md": "one"})
	h.mgr.Boot(context.Background())
	fake.waitPhase(t, 1, api.PhaseLive)
	h.mgr.Wait()

	exiting := helperServices()
	exiting[0].Command = "echo 'Error: REPORT_REGION is not set' >&2; exit 0"
	fake.set(h.spec(2, "two", nil, exiting), map[string]string{"README.md": "two"})
	h.deploymentCall("deploy", 2)
	fake.waitPhase(t, 2, api.PhaseBuilt)
	h.mgr.Wait()
	h.deploymentCall("activate", 2)
	failed := fake.waitPhase(t, 2, api.PhaseFailed)
	h.mgr.Wait()
	if failed.Step != "start" || !strings.Contains(failed.Error, "web exited with code 0 before answering /healthz") {
		t.Fatalf("an exiting web must fail the start step with its exit: %+v", failed)
	}
	// The tail names its source like the control plane's log lines, so the
	// classifier can tell the service's own words from the platform's.
	if !slices.Contains(failed.LogTail, "[web] Error: REPORT_REGION is not set") {
		t.Fatalf("the failure tail lacks the service's stderr, tagged with its name: %q", failed.LogTail)
	}
	if hr := h.health(); hr.Deployment != 1 {
		t.Fatalf("#1 must stay live, got %+v", hr)
	}
}
