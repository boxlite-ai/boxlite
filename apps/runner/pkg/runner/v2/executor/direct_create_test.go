// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package executor

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

type directCreateBackend struct {
	*fakeBackend
	calls      atomic.Int32
	started    chan struct{}
	release    chan struct{}
	contextErr chan error
	startOnce  sync.Once
}

func (b *directCreateBackend) Create(ctx context.Context, _ dto.CreateBoxDTO) (string, string, error) {
	b.calls.Add(1)
	if b.started != nil {
		b.startOnce.Do(func() { close(b.started) })
	}
	if b.release != nil {
		<-b.release
	}
	if b.contextErr != nil {
		b.contextErr <- ctx.Err()
	}
	return "box-1", "direct-daemon", nil
}

type directCreateAccepter interface {
	AcceptDirectCreate(context.Context, *apiclient.Job) error
}

func acceptDirectCreate(executor *Executor, ctx context.Context, job *apiclient.Job) error {
	accepter, ok := any(executor).(directCreateAccepter)
	if !ok {
		return errors.New("direct create acceptance is unavailable")
	}
	return accepter.AcceptDirectCreate(ctx, job)
}

func directCreateJob() *apiclient.Job {
	job := apiclient.NewJob(testJobId, apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, time.Now().Format(time.RFC3339Nano))
	job.SetPayload(`{"id":"box-1","image":"alpine","secretCredential":{"token":"private"}}`)
	return job
}

func waitDirectReports(t *testing.T, h *harness, count int) []reportedStatus {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		if len(h.reported) == count {
			reports := append([]reportedStatus(nil), h.reported...)
			h.mu.Unlock()
			return reports
		}
		h.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	t.Fatalf("callback count = %d, want %d", len(h.reported), count)
	return nil
}

func setDirectReportStatus(h *harness, status int) {
	h.mu.Lock()
	h.reportStatus = status
	h.mu.Unlock()
}

func TestDirectCreateAcceptsBeforeCreateAndDetachesRequestCancellation(t *testing.T) {
	h := newHarness(t, nil)
	backend := &directCreateBackend{
		fakeBackend: h.backend,
		started:     make(chan struct{}),
		release:     make(chan struct{}),
		contextErr:  make(chan error, 1),
	}
	h.executor.backend = backend
	ctx, cancel := context.WithCancel(context.Background())

	if err := acceptDirectCreate(h.executor, ctx, directCreateJob()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-backend.started:
	case <-time.After(time.Second):
		t.Fatal("CREATE_BOX did not start in the background")
	}
	cancel()
	close(backend.release)
	if err := <-backend.contextErr; err != nil {
		t.Fatalf("accepted create inherited request cancellation: %v", err)
	}
	reports := waitDirectReports(t, h, 1)
	assertCompleted(t, reports[0])
	if reports[0].body.GetResultMetadata() != `{"daemonVersion":"direct-daemon"}` {
		t.Fatalf("result metadata = %q", reports[0].body.GetResultMetadata())
	}
}

func TestDirectCreateConcurrentRetriesExecuteOnce(t *testing.T) {
	h := newHarness(t, nil)
	backend := &directCreateBackend{fakeBackend: h.backend, started: make(chan struct{}), release: make(chan struct{})}
	h.executor.backend = backend
	job := directCreateJob()

	const callers = 16
	errorsCh := make(chan error, callers)
	var callersReady sync.WaitGroup
	callersReady.Add(callers)
	for range callers {
		go func() {
			callersReady.Done()
			errorsCh <- acceptDirectCreate(h.executor, context.Background(), job)
		}()
	}
	callersReady.Wait()
	for range callers {
		if err := <-errorsCh; err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-backend.started:
	case <-time.After(time.Second):
		t.Fatal("CREATE_BOX did not start")
	}
	if got := backend.calls.Load(); got != 1 {
		t.Fatalf("native Create calls while blocked = %d, want 1", got)
	}
	close(backend.release)
	waitDirectReports(t, h, 1)

	if err := acceptDirectCreate(h.executor, context.Background(), job); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if got := backend.calls.Load(); got != 1 {
		t.Fatalf("native Create calls after confirmed completion = %d, want 1", got)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.reported) != 1 {
		t.Fatalf("callbacks after confirmed completion = %d, want 1", len(h.reported))
	}
}

func TestDirectCreateRetriesOnlyAnUnconfirmedCompletionCallback(t *testing.T) {
	h := newHarness(t, nil)
	backend := &directCreateBackend{fakeBackend: h.backend}
	h.executor.backend = backend
	job := directCreateJob()
	setDirectReportStatus(h, http.StatusBadRequest)

	if err := acceptDirectCreate(h.executor, context.Background(), job); err != nil {
		t.Fatal(err)
	}
	first := waitDirectReports(t, h, 1)[0]
	setDirectReportStatus(h, http.StatusOK)
	if err := acceptDirectCreate(h.executor, context.Background(), job); err != nil {
		t.Fatal(err)
	}
	second := waitDirectReports(t, h, 2)[1]
	if got := backend.calls.Load(); got != 1 {
		t.Fatalf("native Create calls after callback retry = %d, want 1", got)
	}
	if second.body.Status != first.body.Status || second.body.GetResultMetadata() != first.body.GetResultMetadata() {
		t.Fatalf("callback result changed: first=%#v second=%#v", first.body, second.body)
	}

	if err := acceptDirectCreate(h.executor, context.Background(), job); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.reported) != 2 {
		t.Fatalf("confirmed completion produced another callback: %d", len(h.reported))
	}
}

func TestDirectCreateCacheBoundsCapacityWithoutExpiringRunningJobs(t *testing.T) {
	if defaultJobCacheTTL != 300*time.Second {
		t.Fatalf("default job cache TTL = %v, want 300s", defaultJobCacheTTL)
	}
	now := time.Now()
	cache := newJobCache(time.Minute, 1, func() time.Time { return now })
	first, isNew, err := cache.register("job-1")
	if err != nil || !isNew {
		t.Fatalf("first registration = new=%t, err=%v", isNew, err)
	}
	now = now.Add(2 * time.Minute)
	duplicate, isNew, err := cache.register("job-1")
	if err != nil || isNew || duplicate != first {
		t.Fatalf("running duplicate expired: new=%t, err=%v", isNew, err)
	}
	if _, _, err := cache.register("job-2"); !errors.Is(err, ErrDirectCreateCapacity) {
		t.Fatalf("registration above running capacity = %v, want capacity error", err)
	}

	cache.complete(first, &jobResult{status: apiclient.JOBSTATUS_COMPLETED})
	now = now.Add(30 * time.Second)
	if _, isNew, err := cache.register("job-1"); err != nil || isNew {
		t.Fatalf("completed entry expired before its TTL: new=%t, err=%v", isNew, err)
	}
	cache.markReported(first)
	now = now.Add(31 * time.Second)
	second, isNew, err := cache.register("job-2")
	if err != nil || !isNew {
		t.Fatalf("registration after TTL = new=%t, err=%v", isNew, err)
	}
	if second == first || len(cache.entries) != 1 {
		t.Fatalf("expired entry was not evicted within capacity: %#v", cache.entries)
	}
}
