package proc

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/health"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
)

const (
	minBackoff = time.Second
	maxBackoff = 30 * time.Second
	// A process that stayed up this long before exiting is a fresh incident:
	// the backoff restarts at 1 s instead of continuing from where a crash
	// loop an hour ago left it.
	stableUptime = 30 * time.Second
	maxLineBytes = 16 << 10
	// After SIGKILL the group should vanish at once; this only bounds Stop()
	// when a process is stuck in uninterruptible sleep.
	killWait = 5 * time.Second
)

// Config describes one service instance of one release.
type Config struct {
	Name       string
	Command    string   // run with /bin/sh -c
	Dir        string   // release directory
	Env        []string // complete environment (see deploy.serviceEnv)
	Port       int      // PORT of the exposed command service; 0 = none
	Exposed    bool     // this is the service the gateway routes to
	Health     string   // probe path for the exposed command service; "" = no probe
	Static     bool     // static service: no process, state is always running
	Deployment int
	User       *Cred // run as this identity; nil = as the supervisor

	HealthBudget   time.Duration
	HealthInterval time.Duration
}

// Service supervises one command with the contract's restart policy: on an
// unexpected exit it restarts after 1 s, 2 s, 4 s … capped at 30 s, counting
// restarts and remembering the last exit code for the health report.
type Service struct {
	cfg    Config
	hub    *logs.Hub
	reaper *Reaper

	mu          sync.Mutex
	proc        *os.Process
	pid         int
	exitCh      <-chan syscall.WaitStatus
	gen         int // bumped per spawn so late probe results cannot touch a newer instance
	startedAt   time.Time
	state       string
	health      string
	restarts    int
	lastExit    *int
	healthDone  chan struct{}
	cancelProbe context.CancelFunc
	started     bool
	stopping    bool
	restartReq  bool

	stopCh   chan struct{}
	stopOnce sync.Once
	kick     chan struct{} // wakes a backoff wait early (manual restart)
	done     chan struct{} // closed when supervision ends
}

// New creates an unstarted service.
func New(cfg Config, hub *logs.Hub, reaper *Reaper) *Service {
	if cfg.HealthBudget <= 0 {
		cfg.HealthBudget = health.DefaultBudget
	}
	if cfg.HealthInterval <= 0 {
		cfg.HealthInterval = health.DefaultInterval
	}
	closed := make(chan struct{})
	close(closed)
	return &Service{
		cfg:        cfg,
		hub:        hub,
		reaper:     reaper,
		state:      api.StateStopped,
		health:     api.HealthNone,
		healthDone: closed,
		stopCh:     make(chan struct{}),
		kick:       make(chan struct{}, 1),
		done:       make(chan struct{}),
	}
}

// Name is the service name from the spec.
func (s *Service) Name() string { return s.cfg.Name }

// Config returns the service configuration.
func (s *Service) Config() Config { return s.cfg }

// Start spawns the first instance synchronously (so a command that cannot
// even be exec'd fails the deploy immediately) and then supervises it.
func (s *Service) Start() error {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return errors.New("service already started")
	}
	s.started = true
	if s.cfg.Static {
		s.state = api.StateRunning
		s.mu.Unlock()
		close(s.done)
		return nil
	}
	s.mu.Unlock()
	if err := s.spawn(); err != nil {
		s.mu.Lock()
		s.state = api.StateFailed
		s.mu.Unlock()
		close(s.done)
		return err
	}
	go s.supervise()
	return nil
}

// supervise waits for the running instance and applies the restart policy.
func (s *Service) supervise() {
	defer close(s.done)
	backoff := minBackoff
	for {
		s.mu.Lock()
		exitCh := s.exitCh
		started := s.startedAt
		s.mu.Unlock()

		if exitCh == nil {
			// The previous spawn failed; retry after the backoff.
			if !s.wait(backoff) {
				return
			}
			backoff = min(backoff*2, maxBackoff)
		} else {
			ws := <-exitCh
			code := ExitCode(ws)
			s.mu.Lock()
			_ = s.proc.Release()
			s.proc, s.pid, s.exitCh = nil, 0, nil
			s.lastExit = &code
			if s.cancelProbe != nil {
				s.cancelProbe()
			}
			uptime := time.Since(started)
			switch {
			case s.stopping:
				s.state, s.health = api.StateStopped, api.HealthNone
				s.mu.Unlock()
				s.hub.Systemf(s.cfg.Deployment, api.LevelInfo, "service %s stopped (exit code %d)", s.cfg.Name, code)
				return
			case s.restartReq:
				s.restartReq = false
				s.state, s.health = api.StateRestarting, api.HealthNone
				s.mu.Unlock()
				s.hub.Systemf(s.cfg.Deployment, api.LevelInfo, "service %s stopped for restart (exit code %d)", s.cfg.Name, code)
				backoff = minBackoff
			default:
				s.state, s.health = api.StateRestarting, api.HealthNone
				s.restarts++
				if uptime >= stableUptime {
					backoff = minBackoff
				}
				s.mu.Unlock()
				s.hub.Systemf(s.cfg.Deployment, api.LevelError, "service %s exited with code %d after %s; restarting in %s",
					s.cfg.Name, code, uptime.Round(time.Millisecond), backoff)
				if !s.wait(backoff) {
					return
				}
				backoff = min(backoff*2, maxBackoff)
			}
		}

		if err := s.spawn(); err != nil {
			s.mu.Lock()
			s.state = api.StateFailed
			s.mu.Unlock()
			s.hub.Systemf(s.cfg.Deployment, api.LevelError, "service %s failed to start: %v; retrying in %s", s.cfg.Name, err, backoff)
		}
	}
}

// wait sleeps for d. It returns false when the service is being stopped and
// true when the time elapsed or a manual restart kicked it awake.
func (s *Service) wait(d time.Duration) bool {
	select {
	case <-s.stopCh:
		s.mu.Lock()
		s.state, s.health = api.StateStopped, api.HealthNone
		s.mu.Unlock()
		return false
	case <-s.kick:
		return true
	case <-time.After(d):
		return true
	}
}

// spawn starts one instance. It holds the lock across exec so that Stop()
// either sees no process (and the loop then refuses to spawn) or the real pid.
func (s *Service) spawn() error {
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return errors.New("service is stopping")
	}
	cmd := exec.Command("/bin/sh", "-c", s.cfg.Command)
	cmd.Dir = s.cfg.Dir
	cmd.Env = s.cfg.Env
	// Own process group: Stop signals the group, so `sh -c "a && b"` trees and
	// any grandchildren go down with the leader. With User set the process
	// runs as that uid (the supervisor is root in a Box).
	cmd.SysProcAttr = s.cfg.User.sysProcAttr()
	outR, outW, err := os.Pipe()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		s.mu.Unlock()
		return err
	}
	// *os.File stdio makes exec.Cmd spawn no copy goroutines, and nothing in
	// it ever waits on the child: the Reaper collects the exit status.
	cmd.Stdout, cmd.Stderr = outW, errW
	exitCh, err := s.reaper.Start(cmd)
	outW.Close()
	errW.Close()
	if err != nil {
		outR.Close()
		errR.Close()
		s.mu.Unlock()
		return err
	}
	pid := cmd.Process.Pid
	s.gen++
	gen := s.gen
	s.proc, s.pid = cmd.Process, pid
	s.exitCh = exitCh
	s.startedAt = time.Now()
	s.healthDone = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	s.cancelProbe = cancel
	probe := s.cfg.Health != "" && s.cfg.Port > 0
	if probe {
		s.state, s.health = api.StateStarting, api.HealthStarting
		go s.probe(ctx, gen, s.healthDone)
	} else {
		s.state, s.health = api.StateRunning, api.HealthNone
		close(s.healthDone)
		cancel()
	}
	go pump(outR, s.hub, s.cfg.Name, api.LevelInfo, s.cfg.Deployment)
	go pump(errR, s.hub, s.cfg.Name, api.LevelError, s.cfg.Deployment)
	s.mu.Unlock()

	portInfo := ""
	if s.cfg.Port > 0 {
		portInfo = fmt.Sprintf(", PORT=%d", s.cfg.Port)
	}
	s.hub.Systemf(s.cfg.Deployment, api.LevelInfo, "service %s started (pid %d%s)", s.cfg.Name, pid, portInfo)
	return nil
}

func (s *Service) probe(ctx context.Context, gen int, done chan struct{}) {
	defer close(done)
	url := fmt.Sprintf("http://127.0.0.1:%d%s", s.cfg.Port, s.cfg.Health)
	res := health.Probe(ctx, url, s.cfg.HealthBudget, s.cfg.HealthInterval)
	s.mu.Lock()
	if s.gen == gen && s.proc != nil {
		if res.Healthy {
			s.health = api.HealthHealthy
		} else {
			s.health = api.HealthUnhealthy
		}
		if s.state == api.StateStarting {
			s.state = api.StateRunning
		}
	}
	s.mu.Unlock()
	level := api.LevelInfo
	if !res.Healthy {
		level = api.LevelError
	}
	s.hub.Systemf(s.cfg.Deployment, level, "health check for %s (%s): %s", s.cfg.Name, url, res)
}

// AwaitHealth blocks until the current instance's probe has a verdict (or ctx
// ends) and reports whether the service may take traffic. Services without a
// probe pass trivially.
func (s *Service) AwaitHealth(ctx context.Context) bool {
	s.mu.Lock()
	ch := s.healthDone
	s.mu.Unlock()
	select {
	case <-ch:
	case <-ctx.Done():
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// HealthNone passes only for a running service without a health check: a process
	// that exited before its first answer also ends with HealthNone, and must fail.
	return s.health == api.HealthHealthy || (s.health == api.HealthNone && s.state == api.StateRunning)
}

// Stop ends supervision: SIGTERM to the process group, SIGKILL after grace.
func (s *Service) Stop(grace time.Duration) {
	s.mu.Lock()
	if !s.started || s.cfg.Static {
		s.mu.Unlock()
		return
	}
	s.stopping = true
	s.stopOnce.Do(func() { close(s.stopCh) })
	if s.proc != nil {
		s.signal(syscall.SIGTERM)
	}
	s.mu.Unlock()

	select {
	case <-s.done:
		return
	case <-time.After(grace):
	}
	s.mu.Lock()
	if s.proc != nil {
		s.signal(syscall.SIGKILL)
	}
	s.mu.Unlock()
	select {
	case <-s.done:
	case <-time.After(killWait):
		s.hub.Systemf(s.cfg.Deployment, api.LevelError, "service %s did not exit after SIGKILL", s.cfg.Name)
	}
}

// Restart stops the running instance gracefully and starts a new one without
// counting it as a crash restart; a service sitting in a crash backoff is
// restarted immediately instead.
func (s *Service) Restart(grace time.Duration) {
	s.mu.Lock()
	if !s.started || s.cfg.Static || s.stopping {
		s.mu.Unlock()
		return
	}
	if s.proc == nil {
		select {
		case s.kick <- struct{}{}:
		default:
		}
		s.mu.Unlock()
		return
	}
	gen := s.gen
	s.restartReq = true
	s.signal(syscall.SIGTERM)
	s.mu.Unlock()

	deadline := time.Now().Add(grace)
	for {
		time.Sleep(50 * time.Millisecond)
		s.mu.Lock()
		exited := s.gen != gen || s.proc == nil
		if !exited && time.Now().After(deadline) {
			s.signal(syscall.SIGKILL)
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
		if exited {
			return
		}
	}
}

// signal sends sig to the process group. Caller holds s.mu and s.proc != nil,
// which guarantees the pid has not been reaped and so cannot have been reused.
func (s *Service) signal(sig syscall.Signal) {
	if err := syscall.Kill(-s.pid, sig); err != nil {
		_ = syscall.Kill(s.pid, sig)
	}
}

// Status renders the service for /.boxlite/sv/health and /sv/v1/status.
func (s *Service) Status() api.ServiceStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := api.ServiceStatus{
		Name:     s.cfg.Name,
		State:    s.state,
		Restarts: s.restarts,
		Health:   s.health,
	}
	if s.pid > 0 {
		pid := s.pid
		st.PID = &pid
	}
	if s.lastExit != nil {
		code := *s.lastExit
		st.LastExitCode = &code
	}
	if s.cfg.Port > 0 {
		port := s.cfg.Port
		st.Port = &port
	}
	return st
}

func newLineReader(r io.Reader) *bufio.Reader { return bufio.NewReaderSize(r, 64<<10) }

// readLine reads one line, truncating anything past maxLineBytes rather than
// failing the whole stream on a giant line.
func readLine(br *bufio.Reader) (string, error) {
	var buf []byte
	truncated := false
	for {
		chunk, isPrefix, err := br.ReadLine()
		if room := maxLineBytes - len(buf); room > 0 {
			if len(chunk) > room {
				chunk = chunk[:room]
				truncated = true
			}
			buf = append(buf, chunk...)
		} else if len(chunk) > 0 {
			truncated = true
		}
		if err != nil {
			return string(buf), err
		}
		if !isPrefix {
			break
		}
	}
	if truncated {
		buf = append(buf, " [truncated]"...)
	}
	return string(buf), nil
}
