// Package proc starts, supervises, restarts and stops the services of a release.
package proc

import (
	"context"
	"errors"
	"os"
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
// one goroutine reaps everything, and managed children subscribe to their exit
// status by pid. Statuses of pids nobody has subscribed to yet are parked in
// `unclaimed` to cover the gap between Start() returning and Subscribe() being
// called; statuses of unrelated orphans are discarded.
type Reaper struct {
	mu        sync.Mutex
	waiters   map[int]chan syscall.WaitStatus
	unclaimed map[int]syscall.WaitStatus
	reaped    int64 // total children reaped; for tests and the boot log
}

// NewReaper creates a reaper. Run must be started before any child is spawned.
func NewReaper() *Reaper {
	return &Reaper{waiters: map[int]chan syscall.WaitStatus{}, unclaimed: map[int]syscall.WaitStatus{}}
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
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return // ECHILD (no children) or nothing exited yet
		}
		r.deliver(pid, ws)
	}
}

func (r *Reaper) deliver(pid int, ws syscall.WaitStatus) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reaped++
	if ch, ok := r.waiters[pid]; ok {
		delete(r.waiters, pid)
		ch <- ws
		return
	}
	// Parked for a Subscribe that may be racing with us. Entries for true
	// orphans are dropped on the next sweep so the map cannot grow unbounded.
	r.unclaimed[pid] = ws
	if len(r.unclaimed) > 1024 {
		for p := range r.unclaimed {
			if p != pid {
				delete(r.unclaimed, p)
			}
		}
	}
}

// Subscribe returns a channel that receives pid's exit status exactly once.
// It must be called right after the child is started.
func (r *Reaper) Subscribe(pid int) <-chan syscall.WaitStatus {
	ch := make(chan syscall.WaitStatus, 1)
	r.mu.Lock()
	defer r.mu.Unlock()
	if ws, ok := r.unclaimed[pid]; ok {
		delete(r.unclaimed, pid)
		ch <- ws
		return ch
	}
	r.waiters[pid] = ch
	return ch
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
