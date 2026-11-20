package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
)

const platformGuardStatus = "/network/platform-guard/status"

// One epoch owns Box networking independently of the Box's user policy and
// the shim's lifecycle control socket. Only an unchanged inventory renews it.
type cloudGuardEpoch struct {
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	until  time.Time
}

func newCloudGuardEpoch(ctx context.Context, inventory guardinventory.Observation) *cloudGuardEpoch {
	ctx, cancel := context.WithCancel(ctx)
	return &cloudGuardEpoch{
		ctx: ctx, cancel: cancel,
		until: inventory.Deadline(inventory.Expires),
	}
}

func (e *cloudGuardEpoch) active() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.ctx.Err() == nil && time.Now().Before(e.until)
}

func (e *cloudGuardEpoch) retire() {
	e.mu.Lock()
	e.until = time.Time{}
	e.mu.Unlock()
	e.cancel()
}

func (e *cloudGuardEpoch) renew(sample guardinventory.Observation, expiry time.Time) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	previous := e.until
	if e.ctx.Err() != nil || !time.Now().Before(previous) {
		return false
	}
	e.until = sample.Deadline(expiry)
	// Publication must not revive an already expired lease, including if
	// the monitor was descheduled between checking and storing the lease.
	if !time.Now().Before(previous) {
		e.until = time.Time{}
		return false
	}
	return true
}

func (e *cloudGuardEpoch) watch(directory string, initial guardinventory.Observation) {
	defer e.retire()
	nextPoll := initial.SampledAt.Add(guardinventory.PollInterval)
	for {
		e.mu.Lock()
		until := e.until
		e.mu.Unlock()
		wake := nextPoll
		if until.Before(wake) {
			wake = until
		}
		timer := time.NewTimer(time.Until(wake))
		select {
		case <-timer.C:
		case <-e.ctx.Done():
			timer.Stop()
			return
		}
		if !e.active() {
			return
		}
		poll, cancel := context.WithDeadline(e.ctx, until)
		current, err := guardinventory.Sample(poll, directory)
		cancel()
		if err != nil || current.Revision != initial.Revision || current.Digest != initial.Digest ||
			!slices.Equal(current.HostAddrs, initial.HostAddrs) || !e.renew(current, initial.Expires) {
			return
		}
		nextPoll = current.SampledAt.Add(guardinventory.PollInterval)
	}
}

func (e *cloudGuardEpoch) status(inventory guardinventory.Observation) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "GET required", http.StatusMethodNotAllowed)
			return
		}
		active := e.active()
		w.Header().Set("Content-Type", "application/json")
		if !active {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(struct {
			Revision string `json:"revision"`
			Digest   string `json:"digest"`
			Active   bool   `json:"active"`
		}{inventory.Revision, hex.EncodeToString(inventory.Digest[:]), active})
	}
}
