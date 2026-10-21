// Package proc starts, supervises, restarts and stops the services of a release.
package proc

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Reaper owns every wait(2) call in the process.
//
// The supervisor runs as PID 1 inside the Box, so every orphaned process in the
// Box is re-parented to it and stays a zombie until someone waits for it. If the
// process manager called cmd.Wait() for each child while a generic wait(-1)
// loop ran alongside to collect orphans, the two would race for the same child:
// whichever lost would get ECHILD and the exit status would be gone. So exactly
// one goroutine reaps everything, and managed children are started through
// Start, which registers for the child's exit status.
//
// An exit status must only ever reach the process it belongs to. A pid is
// freed (and may be handed to the next fork) the moment wait4 collects it, so
// two things happen under r.mu as one step each:
//
//   - reaping: wait4 plus delivering the status, and
//   - starting: fork/exec plus registering the waiter for the new pid.
//
// A status is therefore either delivered to a waiter registered before it was
// reaped (whose child still held the pid, so it is that child's status) or it
// belongs to an orphan nobody started through Start, and is dropped at once.
// Nothing is ever parked for later, so a later process that reuses the pid
// cannot be handed a stale status.
type Reaper struct {
	mu      sync.Mutex
	waiters map[int]chan syscall.WaitStatus
	reaped  int64 // total children reaped; tests use it
}

// NewReaper creates a reaper. Run must be started before any child is spawned.
func NewReaper() *Reaper {
	return &Reaper{waiters: map[int]chan syscall.WaitStatus{}}
}

// Run reaps on every SIGCHLD and, as a safety net against coalesced signals,
// once a second. It returns when ctx is cancelled.
func (r *Reaper) Run(ctx context.Context) {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGCHLD)
	defer signal.Stop(sig)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sig:
		case <-tick.C:
		}
		r.reap()
	}
}

// reap collects every exited child without blocking.
func (r *Reaper) reap() {
	for r.reapOne() {
	}
}

// reapOne collects one exited child and delivers its status. It reports
// whether there may be more to collect.
func (r *Reaper) reapOne() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return false // ECHILD (no children) or nothing exited yet
		}
		r.deliverLocked(pid, ws)
		return true
	}
}

// deliverLocked hands ws to the waiter registered for pid, or drops it: a
// status nobody registered for belongs to an orphan. Caller holds r.mu.
func (r *Reaper) deliverLocked(pid int, ws syscall.WaitStatus) {
	r.reaped++
	if ch, ok := r.waiters[pid]; ok {
		delete(r.waiters, pid)
		ch <- ws // buffered, never blocks
	}
}

// Start starts cmd and returns a channel that receives its exit status
// exactly once. Every child the supervisor waits for must be started here,
// never with cmd.Start followed by a separate registration, and never waited
// for with cmd.Wait.
func (r *Reaper) Start(cmd *exec.Cmd) (<-chan syscall.WaitStatus, error) {
	return r.start(func() (int, error) {
		if err := cmd.Start(); err != nil {
			return 0, err
		}
		return cmd.Process.Pid, nil
	})
}

// start runs spawn (which forks and returns the new pid) and registers the
// waiter without letting the reap loop run in between.
func (r *Reaper) start(spawn func() (int, error)) (<-chan syscall.WaitStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pid, err := spawn()
	if err != nil {
		return nil, err
	}
	ch := make(chan syscall.WaitStatus, 1)
	r.waiters[pid] = ch
	return ch, nil
}

// Reaped reports how many children have been collected so far.
func (r *Reaper) Reaped() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reaped
}

// ExitCode converts a wait status to the shell convention: the exit status for
// a normal exit, 128+signal when killed by a signal, -1 if unknown.
func ExitCode(ws syscall.WaitStatus) int {
	switch {
	case ws.Exited():
		return ws.ExitStatus()
	case ws.Signaled():
		return 128 + int(ws.Signal())
	default:
		return -1
	}
}
