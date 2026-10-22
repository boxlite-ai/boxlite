// Package deploy runs the release procedure of contracts.md 2.4 as a small
// state machine with two entry points:
//
//   - build (POST /.boxlite/sv/deploy): fetch spec → extract snapshot → run
//     build steps → report `built`. The live release is untouched.
//   - activate (POST /.boxlite/sv/activate, /rollback): re-fetch spec → start
//     new instances on fresh ports → health-gate the exposed service → flip the
//     gateway → stop the old instances → update `current` → prune → `live`.
//
// The split exists so the control plane can run database migrations between
// the two. At most one build or activation runs at a time; a second request
// gets api.ErrBusy, which the gateway turns into 409.
//
// Every background task runs under the manager's context. Shutdown (SIGTERM)
// and the context given to Boot cancel it: a running build step's process
// group is killed, an activation stops its candidate release, and the boot
// reconcile loop ends.
package deploy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/cp"
	"github.com/boxlite-ai/microcloud/supervisor/internal/envfilter"
	"github.com/boxlite-ai/microcloud/supervisor/internal/health"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
	"github.com/boxlite-ai/microcloud/supervisor/internal/proc"
	"github.com/boxlite-ai/microcloud/supervisor/internal/state"
)

// Switcher is the gateway as seen from here.
type Switcher interface {
	SetSecrets(forward, control string)
	SetTarget(port int, staticDir string)
}

// Options configures a Manager. Zero durations take the contract defaults.
type Options struct {
	CP      *cp.Client
	Hub     *logs.Hub
	Store   *state.Store
	Gate    Switcher
	Reaper  *proc.Reaper
	Version string

	HealthBudget   time.Duration // 60 s
	HealthInterval time.Duration // 500 ms
	SettleWindow   time.Duration // 5 s every service must stay up after the health check, before traffic moves
	StopGrace      time.Duration // 10 s between SIGTERM and SIGKILL
	BuildTimeout   time.Duration // 30 min ceiling for download, extraction and every build step together
	SpecRetry      time.Duration // 5 s between boot-time spec fetches
	Keep           int           // releases kept on disk (3)
	BaseEnv        []string      // inherited environment for services; nil = envfilter.App(os.Environ())

	// RunAs is the identity of every service and build step. The supervisor is
	// root in a Box and app code must not be (contracts.md 2.1); nil runs them
	// as the supervisor (tests, local runs).
	RunAs *proc.Cred
	// Root and SudoLocked are reported by /.boxlite/sv/health.
	Root, SudoLocked bool
}

// Manager owns the live release and runs builds and activations.
type Manager struct {
	o Options

	// ctx is the parent of every background task; cancel ends them all.
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	busy    bool
	closed  bool // Shutdown has begun: nothing new is started
	live    *proc.Group
	current *state.Release

	wg sync.WaitGroup
}

// New creates a manager; call Boot to bring up the current release.
func New(o Options) *Manager {
	if o.HealthBudget <= 0 {
		o.HealthBudget = health.DefaultBudget
	}
	if o.HealthInterval <= 0 {
		o.HealthInterval = health.DefaultInterval
	}
	if o.StopGrace <= 0 {
		o.StopGrace = 10 * time.Second
	}
	if o.SettleWindow <= 0 {
		o.SettleWindow = 5 * time.Second
	}
	if o.BuildTimeout <= 0 {
		o.BuildTimeout = 30 * time.Minute
	}
	if o.SpecRetry <= 0 {
		o.SpecRetry = 5 * time.Second
	}
	if o.Keep <= 0 {
		o.Keep = 3
	}
	if o.BaseEnv == nil {
		o.BaseEnv = envfilter.App(os.Environ(), "")
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{o: o, ctx: ctx, cancel: cancel}
}

// SetGate installs the gateway after construction: the gateway needs the
// manager as its Ops and the manager needs the gateway as its Switcher.
func (m *Manager) SetGate(g Switcher) { m.o.Gate = g }

// ---- gateway.Ops -----------------------------------------------------------

// Health renders GET /.boxlite/sv/health. ok is true once a release is live.
func (m *Manager) Health() api.HealthResponse {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := api.HealthResponse{Version: api.ProtocolVersion, Build: m.o.Version, Root: m.o.Root, SudoLocked: m.o.SudoLocked, Services: []api.ServiceStatus{}}
	if m.current != nil {
		h.Deployment = m.current.Deployment
		h.SpecVersion = m.current.SpecVersion
	}
	if m.live != nil {
		h.OK = true
		h.Services = m.live.Statuses()
	}
	return h
}

// Logs serves GET /.boxlite/sv/logs from the ring buffers.
func (m *Manager) Logs(source string, tail int) []api.LogLine {
	return m.o.Hub.Tail(source, tail)
}

// Deploy builds release n in the background. A release that is already built
// is not rebuilt (the box may have restarted between deploy and activate, or
// the control plane may be retrying); its `built` status is simply re-reported.
func (m *Manager) Deploy(n int) error {
	if n <= 0 {
		return fmt.Errorf("deployment must be positive")
	}
	if err := m.acquire(); err != nil {
		return err
	}
	if m.isBuilt(n) {
		m.spawn(func(ctx context.Context) {
			m.o.Hub.Systemf(n, api.LevelInfo, "deploy #%d: already built, re-reporting", n)
			m.report(ctx, api.Status{Deployment: n, Phase: api.PhaseBuilt})
		})
		return nil
	}
	m.spawn(func(ctx context.Context) { m.build(ctx, n) })
	return nil
}

// Activate starts built release n and flips traffic to it.
func (m *Manager) Activate(n int) error {
	if err := m.acquire(); err != nil {
		return err
	}
	if !m.isBuilt(n) {
		m.release()
		return api.ErrNotBuilt
	}
	m.spawn(func(ctx context.Context) { m.activate(ctx, n, "activate") })
	return nil
}

// Rollback re-activates an older release that is still on disk.
func (m *Manager) Rollback(n int) error {
	if err := m.acquire(); err != nil {
		return err
	}
	if !m.isBuilt(n) {
		m.release()
		return api.ErrNoRelease
	}
	m.spawn(func(ctx context.Context) { m.activate(ctx, n, "rollback") })
	return nil
}

// Restart restarts one service, or all of them when name is empty.
func (m *Manager) Restart(name string) error {
	m.mu.Lock()
	g := m.live
	m.mu.Unlock()
	if g == nil {
		return api.ErrNoRelease
	}
	if name == "" {
		m.o.Hub.Systemf(g.Deployment, api.LevelInfo, "restart requested for all services")
		g.Restart(m.o.StopGrace)
		return nil
	}
	s := g.Find(name)
	if s == nil {
		return api.ErrNoService
	}
	m.o.Hub.Systemf(g.Deployment, api.LevelInfo, "restart requested for service %s", name)
	s.Restart(m.o.StopGrace)
	return nil
}

// ---- lifecycle ---------------------------------------------------------------

// Boot implements step 6 of 2.4: bring the current release back from
// state.json without needing the control plane, then reconcile with
// /sv/v1/spec in the background, retrying until the control plane answers.
// Cancelling ctx cancels every background task, as Shutdown does; Shutdown
// is still what stops the live release.
func (m *Manager) Boot(ctx context.Context) {
	context.AfterFunc(ctx, m.cancel)
	st := m.o.Store.Get()
	m.o.Gate.SetSecrets(st.ForwardSecret, st.ControlSecret)
	onDisk, _ := m.o.Store.ListReleases()
	m.o.Hub.Systemf(st.Current, api.LevelInfo, "supervisor %s booting: state dir %s, current deployment #%d, %d release(s) on disk",
		m.o.Version, m.o.Store.Dir(), st.Current, len(onDisk))

	if rel := st.CurrentRelease(); rel != nil {
		if !m.o.Store.ReleaseExists(rel.Deployment) {
			m.o.Hub.Systemf(rel.Deployment, api.LevelError, "boot: release directory for #%d is missing; waiting for the control plane", rel.Deployment)
		} else if group, err := m.startGroup(*rel, 0); err != nil {
			m.o.Hub.Systemf(rel.Deployment, api.LevelError, "boot: could not start release #%d: %v", rel.Deployment, err)
		} else {
			m.mu.Lock()
			m.live, m.current = group, rel
			m.mu.Unlock()
			m.o.Gate.SetTarget(m.targetFor(group, *rel))
			m.o.Hub.Systemf(rel.Deployment, api.LevelInfo, "boot: release #%d is serving", rel.Deployment)
			m.spawnNoLock(func(ctx context.Context) {
				m.report(ctx, api.Status{Deployment: rel.Deployment, Phase: api.PhaseLive, Services: group.Statuses()})
			})
		}
	}
	m.spawnNoLock(m.reconcile)
}

// reconcile fetches the spec until the control plane answers, then builds and
// activates any deployment newer than the current one.
func (m *Manager) reconcile(ctx context.Context) {
	for attempt := 0; ; attempt++ {
		resp, err := m.o.CP.Spec(ctx)
		if err == nil {
			m.adoptSecrets(resp)
			cur := m.currentDeployment()
			m.o.Hub.Systemf(cur, api.LevelInfo, "boot: control plane reachable; spec names deployment #%d, current is #%d", resp.Deployment, cur)
			if resp.Deployment > cur {
				if err := m.acquire(); err != nil {
					return // the control plane already drove a deploy through the gateway
				}
				m.spawn(func(ctx context.Context) {
					if m.build(ctx, resp.Deployment) {
						m.activate(ctx, resp.Deployment, "deploy")
					}
				})
			}
			return
		}
		if ctx.Err() != nil {
			return
		}
		// Keep polling whatever the answer: the secrets only ever arrive
		// through this call (before the first deploy the control plane answers
		// 200 with spec null, which ends the loop above), so until it succeeds
		// the control plane cannot reach /.boxlite/sv/* at all.
		if attempt == 0 || attempt%12 == 0 {
			var he *cp.HTTPError
			switch {
			case errors.As(err, &he) && (he.Status == http.StatusUnauthorized || he.Status == http.StatusForbidden):
				m.o.Hub.Systemf(m.currentDeployment(), api.LevelError, "boot: the control plane refused this Box's token (HTTP %d); the Box may have been replaced or its env deleted; retrying every %s", he.Status, m.o.SpecRetry)
			case errors.As(err, &he):
				m.o.Hub.Systemf(m.currentDeployment(), api.LevelError, "boot: the control plane answered HTTP %d (%s); retrying every %s", he.Status, he.Body, m.o.SpecRetry)
			default:
				m.o.Hub.Systemf(m.currentDeployment(), api.LevelError, "boot: control plane unreachable (%v); retrying every %s", err, m.o.SpecRetry)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(m.o.SpecRetry):
		}
	}
}

// Shutdown cancels every background task (a build's process group is
// killed, an activation stops its candidate), waits for them to finish, and
// then stops the live release (SIGTERM, grace, SIGKILL). Nothing is started
// afterwards; deploy calls get api.ErrShuttingDown.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	m.cancel()
	m.wg.Wait()

	m.mu.Lock()
	g := m.live
	m.live = nil
	m.mu.Unlock()
	if g != nil {
		m.o.Hub.Systemf(g.Deployment, api.LevelInfo, "supervisor shutting down: stopping release #%d", g.Deployment)
		g.Stop(m.o.StopGrace)
	}
}

// Wait blocks until the background builds, activations and the boot
// reconcile that are running now have finished. Tests use it; Shutdown waits
// the same way.
func (m *Manager) Wait() { m.wg.Wait() }

// ---- the procedure -----------------------------------------------------------

// build runs steps 1–3 of 2.4 and reports built or failed.
func (m *Manager) build(ctx context.Context, n int) bool {
	hub := m.o.Hub
	hub.Systemf(n, api.LevelInfo, "deploy #%d: fetching spec", n)
	resp, err := m.o.CP.Spec(ctx)
	if err != nil {
		m.fail(ctx, n, "spec", err, nil)
		return false
	}
	if resp.Deployment != n {
		m.fail(ctx, n, "spec", fmt.Errorf("control plane spec names deployment #%d, not #%d", resp.Deployment, n), nil)
		return false
	}
	if err := resp.Spec.Validate(); err != nil {
		m.fail(ctx, n, "spec", err, nil)
		return false
	}
	if n == m.currentDeployment() {
		m.fail(ctx, n, "spec", fmt.Errorf("deployment #%d is live; refusing to rebuild it in place", n), nil)
		return false
	}
	m.adoptSecrets(resp)

	// One deadline for download, extraction and every build step: a stalled
	// download must not hold the deploy slot (and so 409 every later deploy)
	// any longer than a hung build step may.
	bctx, cancel := context.WithTimeout(ctx, m.o.BuildTimeout)
	defer cancel()
	dir := m.o.Store.ReleaseDir(n)
	if err := m.o.Store.ResetRelease(n); err != nil {
		m.fail(ctx, n, "extract", err, nil)
		return false
	}
	// A failed build leaves nothing behind: a half-built directory would
	// otherwise count as a release for pruning and confuse a later rollback.
	built := false
	defer func() {
		if !built {
			_ = m.o.Store.RemoveRelease(n)
		}
	}()
	m.report(ctx, api.Status{Deployment: n, Phase: api.PhaseBuilding})

	body, err := m.o.CP.Snapshot(bctx, resp.Snapshot)
	if err != nil {
		m.fail(ctx, n, "download", m.why(ctx, bctx, err), nil)
		return false
	}
	err = m.o.Store.ExtractRelease(n, body)
	body.Close()
	if err != nil {
		// The snapshot streams straight into the extractor, so a stall or
		// the deadline shows up here; it is still the download that failed.
		step := "extract"
		if errors.Is(err, cp.ErrSnapshotStalled) || bctx.Err() != nil {
			step = "download"
		}
		m.fail(ctx, n, step, m.why(ctx, bctx, err), nil)
		return false
	}
	hub.Systemf(n, api.LevelInfo, "deploy #%d: snapshot %s extracted to %s", n, resp.Snapshot.ID, dir)

	rel := state.Release{Deployment: n, SpecVersion: resp.Spec.Version, Spec: resp.Spec, Env: resp.Env, BuiltAt: time.Now().UTC()}
	env := m.serviceEnv(rel, "", 0)
	steps := resp.Spec.Runtime.Build
	for i, cmd := range steps {
		hub.Systemf(n, api.LevelInfo, "deploy #%d: build step %d/%d: %s", n, i+1, len(steps), cmd)
		started := time.Now()
		code, err := proc.RunAs(bctx, m.o.Reaper, hub, api.SourceBuild, n, dir, cmd, env, m.o.RunAs)
		if err != nil {
			m.fail(ctx, n, "build", fmt.Errorf("build step %d (%s): %w", i+1, cmd, m.why(ctx, bctx, err)), m.tailFor(api.SourceBuild, n))
			return false
		}
		if code != 0 {
			m.fail(ctx, n, "build", fmt.Errorf("build step %d (%s) exited with code %d", i+1, cmd, code), m.tailFor(api.SourceBuild, n))
			return false
		}
		hub.Systemf(n, api.LevelInfo, "deploy #%d: build step %d/%d done in %s", n, i+1, len(steps), time.Since(started).Round(time.Millisecond))
	}

	if err := m.o.Store.Update(func(st *state.State) { st.Upsert(rel) }); err != nil {
		m.fail(ctx, n, "build", fmt.Errorf("record release: %w", err), nil)
		return false
	}
	built = true
	hub.Systemf(n, api.LevelInfo, "deploy #%d: built", n)
	m.report(ctx, api.Status{Deployment: n, Phase: api.PhaseBuilt})
	return true
}

// activate runs steps 4–5 of 2.4 for a built release and reports live or
// failed. kind is "deploy", "activate" or "rollback" and only affects logs.
func (m *Manager) activate(ctx context.Context, n int, kind string) bool {
	hub := m.o.Hub
	st := m.o.Store.Get()
	relp := st.Release(n)
	if relp == nil || !m.o.Store.ReleaseExists(n) {
		m.fail(ctx, n, "start", api.ErrNotBuilt, nil)
		return false
	}
	rel := *relp
	hub.Systemf(n, api.LevelInfo, "%s #%d: fetching spec", kind, n)

	// The environment may have changed since the build (DATABASE_URL after
	// migrations, rotated secrets), so the release always starts with the
	// control plane's current env. The services and build recipe stay those
	// of the release itself unless the spec is for this very deployment.
	resp, err := m.o.CP.Spec(ctx)
	if err != nil {
		m.fail(ctx, n, "spec", err, nil)
		return false
	}
	forward, control := resp.Secrets()
	m.o.Gate.SetSecrets(forward, control)
	if resp.Deployment == n {
		if err := resp.Spec.Validate(); err != nil {
			m.fail(ctx, n, "spec", err, nil)
			return false
		}
		rel.Spec = resp.Spec
		rel.SpecVersion = resp.Spec.Version
	}
	rel.Env = resp.Env
	if err := m.o.Store.Update(func(st *state.State) {
		st.ForwardSecret, st.ControlSecret = forward, control
		st.Upsert(rel)
	}); err != nil {
		// Not fatal: the release still starts with the fresh env, but a Box
		// woken without the control plane would come back with the old one.
		hub.Systemf(n, api.LevelError, "%s #%d: could not save the new env and secrets to state.json: %v", kind, n, err)
	}

	if ctx.Err() != nil {
		m.fail(ctx, n, "start", m.why(ctx, ctx, ctx.Err()), nil)
		return false
	}
	m.report(ctx, api.Status{Deployment: n, Phase: api.PhaseStarting})
	group, err := m.startGroup(rel, m.livePort())
	if err != nil {
		m.fail(ctx, n, "start", err, nil)
		return false
	}
	if exp := group.Exposed(); exp != nil {
		hctx, cancel := context.WithTimeout(ctx, m.o.HealthBudget+10*time.Second)
		ok := exp.AwaitHealth(hctx)
		cancel()
		if !ok {
			tail := m.tailFor(exp.Name(), n)
			// Kill the candidate; the old release never stopped serving.
			group.Stop(2 * time.Second)
			if ctx.Err() != nil {
				m.fail(ctx, n, "start", m.why(ctx, ctx, ctx.Err()), tail)
			} else {
				m.fail(ctx, n, "start", healthFailure(exp.Status(), exp.Name(), exp.Config().Health, m.o.HealthBudget), tail)
			}
			return false
		}
	}
	// One good health answer is not enough: an app that answers once and then
	// crashes, or a worker that dies on start, would go live and crash-loop.
	// Every service of the candidate has to stay up for the settle window.
	if name, st := m.settle(ctx, group); name != "" {
		tail := m.tailFor(name, n)
		group.Stop(2 * time.Second)
		if ctx.Err() != nil {
			m.fail(ctx, n, "start", m.why(ctx, ctx, ctx.Err()), tail)
		} else {
			m.fail(ctx, n, "start", fmt.Errorf("service %s %s within %s of starting", name, st, m.o.SettleWindow), tail)
		}
		return false
	}
	if ctx.Err() != nil {
		// Cancelled while the candidate came up: it never takes traffic.
		group.Stop(2 * time.Second)
		m.fail(ctx, n, "start", m.why(ctx, ctx, ctx.Err()), nil)
		return false
	}

	// Flip. The gateway target is swapped atomically before the old release is
	// told to stop, so there is no instant without a backend.
	m.mu.Lock()
	old := m.live
	m.live, m.current = group, &rel
	m.mu.Unlock()
	m.o.Gate.SetTarget(m.targetFor(group, rel))
	hub.Systemf(n, api.LevelInfo, "%s #%d: gateway switched to release #%d", kind, n, n)
	if old != nil {
		hub.Systemf(n, api.LevelInfo, "%s #%d: stopping release #%d", kind, n, old.Deployment)
		old.Stop(m.o.StopGrace)
	}
	if err := m.o.Store.SetCurrent(n, rel.SpecVersion); err != nil {
		hub.Systemf(n, api.LevelError, "%s #%d: could not update current: %v", kind, n, err)
	}
	if removed, err := m.o.Store.Prune(m.o.Keep, n); err != nil {
		hub.Systemf(n, api.LevelError, "%s #%d: prune: %v", kind, n, err)
	} else if len(removed) > 0 {
		if err := m.o.Store.Update(func(st *state.State) { st.Forget(removed) }); err != nil {
			hub.Systemf(n, api.LevelError, "%s #%d: could not drop pruned release(s) %v from state.json: %v", kind, n, removed, err)
		}
		hub.Systemf(n, api.LevelInfo, "%s #%d: pruned old release(s) %v", kind, n, removed)
	}
	hub.Systemf(n, api.LevelInfo, "%s #%d: live", kind, n)
	m.report(ctx, api.Status{Deployment: n, Phase: api.PhaseLive, Services: group.Statuses()})
	return true
}

// settle waits SettleWindow and returns the first service that exited or
// restarted meanwhile, with a short description; "" when all stayed up.
// healthFailure says why the exposed service did not pass its health check: it
// exited (and how), or it ran but never answered healthy in time.
func healthFailure(st api.ServiceStatus, name, path string, budget time.Duration) error {
	if st.State != api.StateRunning && st.State != api.StateStarting && st.LastExitCode != nil {
		return fmt.Errorf("service %s exited with code %d before answering %s", name, *st.LastExitCode, path)
	}
	return fmt.Errorf("service %s failed its health check within %s", name, budget)
}

func (m *Manager) settle(ctx context.Context, group *proc.Group) (string, string) {
	t := time.NewTimer(m.o.SettleWindow)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return "", ""
	case <-t.C:
	}
	for _, st := range group.Statuses() {
		if st.Restarts == 0 && (st.State == "running" || st.State == "starting") {
			continue
		}
		what := "stopped"
		if st.LastExitCode != nil {
			what = fmt.Sprintf("exited with code %d", *st.LastExitCode)
		}
		if st.Restarts > 0 {
			what += fmt.Sprintf(" (restarted %d time(s))", st.Restarts)
		}
		return st.Name, what
	}
	return "", ""
}

// startGroup starts every service of rel. The exposed command service gets a
// PORT different from excludePort (the live release's port) so both releases
// can listen side by side during the health gate.
func (m *Manager) startGroup(rel state.Release, excludePort int) (*proc.Group, error) {
	dir := m.o.Store.ReleaseDir(rel.Deployment)
	exposed, hasExposed := rel.Spec.Exposed()
	group := &proc.Group{Deployment: rel.Deployment}
	for _, svc := range rel.Spec.Services {
		cfg := proc.Config{
			Name:           svc.Name,
			Dir:            dir,
			Deployment:     rel.Deployment,
			HealthBudget:   m.o.HealthBudget,
			HealthInterval: m.o.HealthInterval,
			Exposed:        hasExposed && exposed.Name == svc.Name,
			User:           m.o.RunAs,
		}
		if svc.IsStatic() {
			cfg.Static = true
			if cfg.Exposed && !m.staticExists(filepath.Join(dir, svc.Static)) {
				group.Stop(0)
				return nil, fmt.Errorf("static service %s: directory %q not found in release (did the build produce it?)", svc.Name, svc.Static)
			}
		} else {
			cfg.Command = svc.Command
			port := 0
			if cfg.Exposed {
				p, err := proc.FreePort(excludePort)
				if err != nil {
					group.Stop(0)
					return nil, err
				}
				port = p
				cfg.Port = port
				cfg.Health = normalizePath(svc.HealthPath())
			}
			cfg.Env = m.serviceEnv(rel, svc.Name, port)
		}
		s := proc.New(cfg, m.o.Hub, m.o.Reaper)
		if err := s.Start(); err != nil {
			group.Stop(0)
			return nil, fmt.Errorf("start service %s: %w", svc.Name, err)
		}
		group.Services = append(group.Services, s)
	}
	return group, nil
}

// serviceEnv builds the environment for a service (or for build steps when
// name is empty): the filtered supervisor environment, then the spec env from
// the control plane, then BOXLITE_ENV (if the spec env lacks it),
// BOXLITE_SERVICE and, for the exposed command service, PORT.
func (m *Manager) serviceEnv(rel state.Release, name string, port int) []string {
	env := map[string]string{}
	for _, kv := range m.o.BaseEnv {
		k, v, _ := strings.Cut(kv, "=")
		env[k] = v
	}
	// A dropped identity must not inherit root's HOME or name; the app's own
	// [variables] may still override these deliberately.
	if u := m.o.RunAs; u != nil {
		env["HOME"], env["USER"], env["LOGNAME"] = u.Home, u.Name, u.Name
	}
	for k, v := range rel.Env {
		env[k] = v
	}
	if _, ok := env["BOXLITE_ENV"]; !ok && rel.Spec.Environment != "" {
		env["BOXLITE_ENV"] = rel.Spec.Environment
	}
	delete(env, "PORT")
	delete(env, "BOXLITE_SERVICE")
	if name != "" {
		env["BOXLITE_SERVICE"] = name
	}
	if port > 0 {
		env["PORT"] = strconv.Itoa(port)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+env[k])
	}
	return out
}

func (m *Manager) targetFor(group *proc.Group, rel state.Release) (int, string) {
	exp := group.Exposed()
	if exp == nil {
		return 0, ""
	}
	if svc, ok := rel.Spec.Exposed(); ok && svc.IsStatic() {
		return 0, filepath.Join(m.o.Store.ReleaseDir(rel.Deployment), svc.Static)
	}
	return exp.Config().Port, ""
}

// ---- helpers -------------------------------------------------------------------

func (m *Manager) acquire() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return api.ErrShuttingDown
	}
	if m.busy {
		return api.ErrBusy
	}
	m.busy = true
	return nil
}

func (m *Manager) release() {
	m.mu.Lock()
	m.busy = false
	m.mu.Unlock()
}

// spawn runs fn in the background under the manager's context and releases
// the busy flag afterwards. The caller holds the flag (acquire).
func (m *Manager) spawn(fn func(context.Context)) {
	if !m.track() {
		m.release()
		return
	}
	go func() {
		defer m.wg.Done()
		defer m.release()
		fn(m.ctx)
	}()
}

// spawnNoLock runs fn in the background without touching the busy flag.
func (m *Manager) spawnNoLock(fn func(context.Context)) {
	if !m.track() {
		return
	}
	go func() {
		defer m.wg.Done()
		fn(m.ctx)
	}()
}

// track counts one more background task unless Shutdown has begun. Checking
// closed and adding to wg under one lock means Shutdown's wg.Wait never races
// with an Add.
func (m *Manager) track() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return false
	}
	m.wg.Add(1)
	return true
}

// why explains a failure caused by a context: the supervisor shutting down
// (ctx, the task's own context, ended) or the step's deadline (stepCtx).
// Other errors pass through.
func (m *Manager) why(ctx, stepCtx context.Context, err error) error {
	switch {
	case ctx.Err() != nil:
		return fmt.Errorf("cancelled because the supervisor is shutting down: %w", err)
	case errors.Is(stepCtx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("timed out after %s (download, extraction and build share one deadline): %w", m.o.BuildTimeout, err)
	}
	return err
}

func (m *Manager) isBuilt(n int) bool {
	st := m.o.Store.Get()
	return st.Release(n) != nil && m.o.Store.ReleaseExists(n)
}

// adoptSecrets installs the secrets of a spec response in the gateway and
// persists them, so a woken Box accepts the control plane before it can
// reach it.
func (m *Manager) adoptSecrets(resp *api.SpecResponse) {
	forward, control := resp.Secrets()
	m.o.Gate.SetSecrets(forward, control)
	if err := m.o.Store.Update(func(st *state.State) { st.ForwardSecret, st.ControlSecret = forward, control }); err != nil {
		m.o.Hub.Systemf(m.currentDeployment(), api.LevelError, "could not save the gateway secrets to state.json (a Box woken without the control plane would refuse it): %v", err)
	}
}

// staticExists checks a static directory through the store, so the check sees
// exactly what the gateway will serve.
func (m *Manager) staticExists(dir string) bool {
	r, err := m.o.Store.OpenStatic(dir)
	if err != nil {
		return false
	}
	r.Close()
	return true
}

func (m *Manager) currentDeployment() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return 0
	}
	return m.current.Deployment
}

func (m *Manager) livePort() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.live == nil {
		return 0
	}
	if exp := m.live.Exposed(); exp != nil {
		return exp.Config().Port
	}
	return 0
}

func (m *Manager) liveStatuses() []api.ServiceStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.live == nil {
		return []api.ServiceStatus{}
	}
	return m.live.Statuses()
}

// tailFor returns the last 50 lines of one source that belong to deployment n.
func (m *Manager) tailFor(source string, n int) []string {
	all := m.o.Hub.Tail(source, 0)
	var mine []api.LogLine
	for _, l := range all {
		if l.Deployment == n {
			mine = append(mine, l)
		}
	}
	if len(mine) > 50 {
		mine = mine[len(mine)-50:]
	}
	return logs.Lines(mine)
}

// fail logs and reports a failed phase. The live release is never touched.
func (m *Manager) fail(ctx context.Context, n int, step string, err error, tail []string) {
	m.o.Hub.Systemf(n, api.LevelError, "deployment #%d failed at step %s: %v (previous release stays live)", n, step, err)
	m.report(ctx, api.Status{Deployment: n, Phase: api.PhaseFailed, Step: step, Error: err.Error(), LogTail: tail})
}

// report posts a status with a short retry; the control plane also learns the
// outcome from the log stream and from /.boxlite/sv/health, so a lost status
// is not fatal. When ctx has already ended (shutdown), one attempt is still
// made under a short deadline so the control plane hears why the deployment
// stopped.
func (m *Manager) report(ctx context.Context, st api.Status) {
	if st.Services == nil {
		st.Services = m.liveStatuses()
	}
	if ctx.Err() != nil {
		lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		if err := m.o.CP.PostStatus(lctx, st); err != nil {
			m.o.Hub.Systemf(st.Deployment, api.LevelError, "could not report phase %q for #%d to the control plane: %v", st.Phase, st.Deployment, err)
		}
		return
	}
	var err error
	for _, delay := range []time.Duration{time.Second, 2 * time.Second, 0} {
		if err = m.o.CP.PostStatus(ctx, st); err == nil {
			return
		}
		if delay == 0 || ctx.Err() != nil {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
	m.o.Hub.Systemf(st.Deployment, api.LevelError, "could not report phase %q for #%d to the control plane: %v", st.Phase, st.Deployment, err)
}

func normalizePath(p string) string {
	if p == "" {
		return ""
	}
	if !strings.HasPrefix(p, "/") {
		return "/" + p
	}
	return p
}
