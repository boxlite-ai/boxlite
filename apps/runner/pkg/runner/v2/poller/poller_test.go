/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package poller

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

// recordingExecutor stands in for the real *executor.Executor (which would
// spawn libkrun VMs). It records how many Execute calls overlap so a test can
// assert the spawn gate actually bounds concurrency.
type recordingExecutor struct {
	delay       time.Duration
	inFlight    int32
	maxInFlight int32
	total       int32
	wg          sync.WaitGroup
}

func (r *recordingExecutor) Execute(ctx context.Context, job *apiclient.Job) {
	defer r.wg.Done()
	cur := atomic.AddInt32(&r.inFlight, 1)
	for {
		peak := atomic.LoadInt32(&r.maxInFlight)
		if cur <= peak || atomic.CompareAndSwapInt32(&r.maxInFlight, peak, cur) {
			break
		}
	}
	time.Sleep(r.delay)
	atomic.AddInt32(&r.total, 1)
	atomic.AddInt32(&r.inFlight, -1)
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func jobOfType(id string, t apiclient.JobType) *apiclient.Job {
	j := apiclient.NewJobWithDefaults()
	j.SetId(id)
	j.SetType(t)
	return j
}

// A runner waking up after a reboot replays every in-flight START_BOX at once,
// and the API keeps dispatching more. Without a gate each one spawns a ~180MB
// libkrun VM concurrently and OOMs the host (the prod reboot loop). The gate
// must bound how many spawn jobs execute simultaneously.
func TestDispatch_GatesSpawnJobConcurrency(t *testing.T) {
	const limit = 4
	const njobs = 20

	rec := &recordingExecutor{delay: 30 * time.Millisecond}
	rec.wg.Add(njobs)

	s := &Service{
		log:      quietLogger(),
		executor: rec,
		spawnSem: make(chan struct{}, limit),
	}

	ctx := context.Background()
	for i := 0; i < njobs; i++ {
		s.dispatch(ctx, jobOfType(fmt.Sprintf("job-%d", i), apiclient.JOBTYPE_START_BOX))
	}
	rec.wg.Wait()

	if got := atomic.LoadInt32(&rec.total); got != njobs {
		t.Fatalf("all spawn jobs must run: executed %d, want %d", got, njobs)
	}
	if peak := atomic.LoadInt32(&rec.maxInFlight); peak > limit {
		t.Fatalf("spawn concurrency exceeded gate: peak in-flight=%d, want <=%d", peak, limit)
	}
}

// Stop/destroy jobs free memory rather than spawn VMs, so they must NOT be held
// behind the spawn gate — otherwise cleanup stalls behind slow spawns during an
// incident. With a gate of 1 busy slot, several stop jobs must still overlap.
func TestDispatch_DoesNotGateNonSpawnJobs(t *testing.T) {
	const njobs = 6

	rec := &recordingExecutor{delay: 30 * time.Millisecond}
	rec.wg.Add(njobs)

	s := &Service{
		log:      quietLogger(),
		executor: rec,
		spawnSem: make(chan struct{}, 1), // spawn gate fully saturated at 1
	}

	ctx := context.Background()
	for i := 0; i < njobs; i++ {
		s.dispatch(ctx, jobOfType(fmt.Sprintf("stop-%d", i), apiclient.JOBTYPE_STOP_BOX))
	}
	rec.wg.Wait()

	if peak := atomic.LoadInt32(&rec.maxInFlight); peak <= 1 {
		t.Fatalf("non-spawn jobs were serialized by the spawn gate: peak in-flight=%d, want >1", peak)
	}
}

func TestIsSpawnJob(t *testing.T) {
	cases := map[apiclient.JobType]bool{
		apiclient.JOBTYPE_CREATE_BOX:                  true,
		apiclient.JOBTYPE_START_BOX:                   true,
		apiclient.JOBTYPE_RECOVER_BOX:                 true,
		apiclient.JOBTYPE_STOP_BOX:                    false,
		apiclient.JOBTYPE_DESTROY_BOX:                 false,
		apiclient.JOBTYPE_RESIZE_BOX:                  false,
		apiclient.JOBTYPE_UPDATE_BOX_NETWORK_SETTINGS: false,
	}
	for jobType, want := range cases {
		j := apiclient.NewJobWithDefaults()
		j.SetType(jobType)
		if got := isSpawnJob(j); got != want {
			t.Errorf("isSpawnJob(%s)=%v, want %v", jobType, got, want)
		}
	}
}
