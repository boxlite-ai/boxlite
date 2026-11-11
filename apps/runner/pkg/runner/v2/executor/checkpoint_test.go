// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
)

type checkpointBackend struct {
	*fakeBackend
	capture func(context.Context, string, string) (string, string, error)
	restore func(context.Context, checkpoint.RestoreRequest, string, checkpoint.Artifacts, storage.ArchiveStore) (checkpoint.RestoreResult, error)
	start   func()
}

func (b *checkpointBackend) RestoreCheckpoint(ctx context.Context, request checkpoint.RestoreRequest, attemptID string, artifacts checkpoint.Artifacts, store storage.ArchiveStore) (checkpoint.RestoreResult, error) {
	if b.restore == nil {
		return checkpoint.RestoreResult{}, errors.New("unexpected checkpoint restore")
	}
	return b.restore(ctx, request, attemptID, artifacts, store)
}

func (b *checkpointBackend) RetireCheckpointTarget(_ context.Context, target string) error {
	b.calls.record("retire:%s", target)
	return nil
}

func TestCheckpointDeleteRetiresTargetBeforeNativeDestroy(t *testing.T) {
	h, _, _ := checkpointHarness(t)
	job := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_DESTROY_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, "2026-11-06T00:00:00Z")
	if _, err := h.executor.executeJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	got := h.calls.snapshot()
	if len(got) != 2 || got[0] != "retire:"+testBoxId || got[1] != "destroy:"+testBoxId {
		t.Fatalf("deletion did not fence late checkpoint jobs first: %v", got)
	}
}

func TestCheckpointDeleteAcceptsAnAlreadyAbsentNativeTarget(t *testing.T) {
	h, backend, _ := checkpointHarness(t)
	backend.destroyErr = &boxlite.Error{Code: boxlite.ErrNotFound, Message: "import never created the target"}
	job := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_DESTROY_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, "2026-11-06T00:00:00Z")
	if _, err := h.executor.executeJob(context.Background(), job); err != nil {
		t.Fatalf("cancelled checkpoint target cannot finish deletion: %v", err)
	}
}

func (b *checkpointBackend) ExportCheckpoint(ctx context.Context, boxID, directory string) (string, string, error) {
	if b.capture != nil {
		return b.capture(ctx, boxID, directory)
	}
	archive, err := b.fakeBackend.ExportBox(ctx, boxID, directory)
	return archive, "example/app@sha256:" + strings.Repeat("a", 64), err
}

func (b *checkpointBackend) Start(context.Context, string, *string, map[string]string, bool) (string, error) {
	if b.start != nil {
		b.start()
	}
	return "boxlite", nil
}

func checkpointHarness(t *testing.T) (*harness, *checkpointBackend, *apiclient.Job) {
	t.Helper()
	h := newHarness(t, nil)
	h.executor.checkpointWorkDir = filepath.Join(h.workDir, "checkpoints")
	backend := &checkpointBackend{fakeBackend: h.backend}
	h.executor.backend = backend
	payload, err := json.Marshal(ExportCheckpointPayload{CheckpointID: uuid.NewString(), ArcPath: "gs://bucket/checkpoints/" + uuid.NewString() + ".boxlite"})
	if err != nil {
		t.Fatal(err)
	}
	job := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_EXPORT_CHECKPOINT, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, "2026-11-06T00:00:00Z")
	job.SetPayload(string(payload))
	return h, backend, job
}

func capturedArtifact(t *testing.T, h *harness, job *apiclient.Job) checkpoint.Artifact {
	t.Helper()
	report := h.lastReport(t)
	if report.method != http.MethodPost || report.path != "/jobs/"+job.Id+"/status" || report.body.Status != apiclient.JOBSTATUS_COMPLETED {
		t.Fatalf("checkpoint completion callback: %s %s %#v", report.method, report.path, report.body)
	}
	var artifact checkpoint.Artifact
	if err := json.Unmarshal([]byte(report.body.GetResultMetadata()), &artifact); err != nil {
		t.Fatal(err)
	}
	return artifact
}

func uploadJob(t *testing.T, artifact checkpoint.Artifact) *apiclient.Job {
	t.Helper()
	bytes, err := json.Marshal(artifact)
	if err != nil {
		t.Fatal(err)
	}
	job := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_UPLOAD_CHECKPOINT, apiclient.JOBSTATUS_IN_PROGRESS, "CHECKPOINT", artifact.CheckpointID, "2026-11-06T00:00:00Z")
	job.SetPayload(string(bytes))
	return job
}

func artifactPath(h *harness, record checkpoint.Artifact) string {
	return filepath.Join(h.executor.checkpointWorkDir, record.CheckpointID, record.ExportJobID, "archive.boxlite")
}

func TestCheckpointExportReportsAnArtifactWithoutUploadingOrStopping(t *testing.T) {
	h, _, job := checkpointHarness(t)
	h.executor.Execute(context.Background(), job)
	artifact := capturedArtifact(t, h, job)
	if artifact.ExportJobID != job.Id || artifact.SourceBoxID != job.ResourceId {
		t.Fatal("capture lost its job/source identity")
	}
	if got := h.calls.snapshot(); len(got) != 1 || got[0] != "export:"+testBoxId {
		t.Fatalf("unexpected side effects: %v", got)
	}
	if _, err := os.Stat(artifactPath(h, artifact)); err != nil {
		t.Fatal(err)
	}
}

func TestCheckpointExportCancellationBeforeLateNativeResultKeepsTheArchive(t *testing.T) {
	h, backend, job := checkpointHarness(t)
	entered, resume := make(chan struct{}), make(chan struct{})
	backend.capture = func(ctx context.Context, source, directory string) (string, string, error) {
		close(entered)
		<-resume
		if ctx.Err() != nil {
			return "", "", errors.New("native export received cancellation")
		}
		archive, err := backend.fakeBackend.ExportBox(ctx, source, directory)
		return archive, "example/app@sha256:" + strings.Repeat("b", 64), err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { h.executor.Execute(ctx, job); close(done) }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("export did not start")
	}
	cancel()
	close(resume)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("late export did not complete")
	}
	artifact := capturedArtifact(t, h, job)
	if _, err := os.Stat(artifactPath(h, artifact)); err != nil {
		t.Fatalf("late successful archive was discarded: %v", err)
	}
}

func TestCheckpointUploadCleansOnlyAfterTerminalCallbackIsAcknowledged(t *testing.T) {
	for _, acknowledge := range []bool{false, true} {
		t.Run(map[bool]string{false: "callback-rejected", true: "callback-accepted"}[acknowledge], func(t *testing.T) {
			h, _, job := checkpointHarness(t)
			h.executor.Execute(context.Background(), job)
			artifact := capturedArtifact(t, h, job)
			var callbackCount atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				callbackCount.Add(1)
				if !acknowledge {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"id":"accepted","type":"UPLOAD_CHECKPOINT","status":"COMPLETED","resourceType":"CHECKPOINT","resourceId":"cp","createdAt":"2026-11-06T00:00:00Z"}`))
			}))
			defer server.Close()
			config := apiclient.NewConfiguration()
			config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
			h.executor.client = apiclient.NewAPIClient(config)
			h.executor.Execute(context.Background(), uploadJob(t, artifact))
			if callbackCount.Load() != 1 {
				t.Fatalf("terminal callbacks: %d", callbackCount.Load())
			}
			if h.store.uploadedKey != artifact.ArcPath {
				t.Fatal("upload used a different object key")
			}
			_, err := os.Stat(artifactPath(h, artifact))
			if acknowledge && !os.IsNotExist(err) {
				t.Fatalf("acknowledged archive was not cleaned: %v", err)
			}
			if !acknowledge && err != nil {
				t.Fatalf("callback failure discarded archive: %v", err)
			}
		})
	}
}

type blockedCheckpointStore struct {
	storage.ArchiveStore
	entered chan struct{}
	resume  chan struct{}
}

func (s *blockedCheckpointStore) Upload(ctx context.Context, key, path string) error {
	close(s.entered)
	select {
	case <-s.resume:
	case <-ctx.Done():
		return ctx.Err()
	}
	return s.ArchiveStore.Upload(ctx, key, path)
}

func TestCheckpointUploadDoesNotHoldTheBoxJobOperationLease(t *testing.T) {
	h, backend, job := checkpointHarness(t)
	h.executor.Execute(context.Background(), job)
	artifact := capturedArtifact(t, h, job)
	store := &blockedCheckpointStore{ArchiveStore: h.store, entered: make(chan struct{}), resume: make(chan struct{})}
	h.executor.archiveStore = store
	uploadDone := make(chan struct{})
	upload := uploadJob(t, artifact)
	go func() { h.executor.Execute(context.Background(), upload); close(uploadDone) }()
	select {
	case <-store.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("upload did not start")
	}
	started := make(chan struct{})
	backend.start = func() { close(started) }
	start := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_START_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, "2026-11-06T00:00:00Z")
	start.SetPayload("{}")
	startDone := make(chan struct{})
	go func() { _, _ = h.executor.executeJob(context.Background(), start); close(startDone) }()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		close(store.resume)
		t.Fatal("upload blocked source start")
	}
	close(store.resume)
	select {
	case <-startDone:
	case <-time.After(10 * time.Second):
		t.Fatal("start did not finish")
	}
	select {
	case <-uploadDone:
	case <-time.After(10 * time.Second):
		t.Fatal("upload did not finish")
	}
}

func TestCheckpointExportRejectsUnsupportedStorageBeforeNativeCapture(t *testing.T) {
	h, _, job := checkpointHarness(t)
	h.executor.archiveStore = &storage.SchemeArchiveStore{}
	h.executor.Execute(context.Background(), job)
	if report := h.lastReport(t); report.body.Status != apiclient.JOBSTATUS_FAILED {
		t.Fatal("unsupported storage was accepted")
	}
	if calls := h.calls.snapshot(); len(calls) != 0 {
		t.Fatalf("native side effects before configuration validation: %v", calls)
	}
}

func TestCheckpointJobEnumsSurviveTheGeneratedClientDecoder(t *testing.T) {
	for _, jobType := range []apiclient.JobType{apiclient.JOBTYPE_EXPORT_CHECKPOINT, apiclient.JOBTYPE_UPLOAD_CHECKPOINT, apiclient.JOBTYPE_IMPORT_CHECKPOINT} {
		var decoded apiclient.JobType
		encoded, err := json.Marshal(jobType)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &decoded); err != nil || decoded != jobType {
			t.Fatalf("polled job type was lost: %s %v", decoded, err)
		}
	}
}

func TestCheckpointImportJobReportsItsOwnedNativeResult(t *testing.T) {
	h, backend, _ := checkpointHarness(t)
	nativeID := uuid.NewString()
	operationID := uuid.NewString()
	job := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_IMPORT_CHECKPOINT, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, "2026-11-06T00:00:00Z")
	request := checkpoint.RestoreRequest{
		OperationID: operationID, Sequence: 1, Target: testBoxId, Mode: "recover",
		Archive: checkpoint.Artifact{Reference: checkpoint.Reference{ArcPath: "gs://bucket/checkpoints/source.boxlite"}},
	}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	job.SetPayload(string(payload))
	var restoreCalls atomic.Int32
	backend.restore = func(ctx context.Context, actual checkpoint.RestoreRequest, attemptID string, artifacts checkpoint.Artifacts, store storage.ArchiveStore) (checkpoint.RestoreResult, error) {
		restoreCalls.Add(1)
		if actual.Target != testBoxId || actual.OperationID != operationID || attemptID != job.Id || artifacts.Root != h.executor.checkpointWorkDir || store != h.executor.archiveStore {
			t.Error("executor changed recovery identity or transfer ownership")
		}
		if ctx.Err() != nil {
			t.Errorf("accepted import inherited caller cancellation: %v", ctx.Err())
		}
		return checkpoint.RestoreResult{OperationID: actual.OperationID, Sequence: actual.Sequence, NativeID: nativeID}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h.executor.Execute(ctx, job)
	report := h.lastReport(t)
	if report.body.Status != apiclient.JOBSTATUS_COMPLETED {
		t.Fatalf("checkpoint import was not completed: %#v", report.body)
	}
	var result checkpoint.RestoreResult
	if err := json.Unmarshal([]byte(report.body.GetResultMetadata()), &result); err != nil || result.NativeID != nativeID || result.OperationID != operationID || result.Sequence != 1 {
		t.Fatalf("checkpoint native receipt did not reach API: %#v %v", result, err)
	}
	job.ResourceId = "different-target"
	h.mu.Lock()
	h.reported = nil
	h.mu.Unlock()
	h.executor.Execute(context.Background(), job)
	if report := h.lastReport(t); report.body.Status != apiclient.JOBSTATUS_FAILED {
		t.Fatalf("checkpoint job accepted another resource owner: %#v", report.body)
	}
	if restoreCalls.Load() != 1 {
		t.Fatal("mismatched target reached native recovery")
	}
}

func TestCheckpointJobsRejectInvalidPayloadOwnershipAndConfiguration(t *testing.T) {
	for _, kind := range []apiclient.JobType{apiclient.JOBTYPE_EXPORT_CHECKPOINT, apiclient.JOBTYPE_UPLOAD_CHECKPOINT, apiclient.JOBTYPE_IMPORT_CHECKPOINT} {
		for _, damage := range []string{"payload", "resource", "work-directory", "store", "backend"} {
			if kind == apiclient.JOBTYPE_UPLOAD_CHECKPOINT && damage == "backend" {
				continue
			}
			t.Run(string(kind)+"/"+damage, func(t *testing.T) {
				h, backend, export := checkpointHarness(t)
				h.executor.Execute(t.Context(), export)
				artifact := capturedArtifact(t, h, export)
				job := export
				if kind == apiclient.JOBTYPE_UPLOAD_CHECKPOINT {
					job = uploadJob(t, artifact)
				}
				if kind == apiclient.JOBTYPE_IMPORT_CHECKPOINT {
					job = apiclient.NewJob(uuid.NewString(), kind, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", testBoxId, "2026-11-06T00:00:00Z")
					payload, err := json.Marshal(checkpoint.RestoreRequest{OperationID: uuid.NewString(), Sequence: 1, Target: testBoxId, Mode: "create", Archive: artifact, PlatformEnv: map[string]string{"BOXLITE_BOX_ID": testBoxId}})
					if err != nil {
						t.Fatal(err)
					}
					job.SetPayload(string(payload))
				}
				backend.restore = func(context.Context, checkpoint.RestoreRequest, string, checkpoint.Artifacts, storage.ArchiveStore) (checkpoint.RestoreResult, error) {
					t.Error("rejected job reached native restore")
					return checkpoint.RestoreResult{}, nil
				}
				before := len(h.calls.snapshot())
				switch damage {
				case "payload":
					job.SetPayload("{")
				case "resource":
					job.ResourceType = "UNRELATED"
				case "work-directory":
					h.executor.checkpointWorkDir = ""
				case "store":
					h.executor.archiveStore = nil
				case "backend":
					h.executor.backend = h.backend
				}
				if _, err := h.executor.executeJob(t.Context(), job); err == nil {
					t.Fatal("invalid checkpoint job was accepted")
				}
				if len(h.calls.snapshot()) != before {
					t.Fatal("rejected job performed a native operation")
				}
			})
		}
	}
}

func TestCheckpointUploadAcknowledgmentRetainsArchiveOnInvalidCleanup(t *testing.T) {
	for _, damage := range []string{"type", "payload", "resource", "work-directory", "store", "unsupported-scheme", "metadata"} {
		t.Run(damage, func(t *testing.T) {
			h, _, export := checkpointHarness(t)
			h.executor.Execute(t.Context(), export)
			artifact := capturedArtifact(t, h, export)
			path := artifactPath(h, artifact)
			job := uploadJob(t, artifact)
			switch damage {
			case "type":
				job.Type = apiclient.JOBTYPE_EXPORT_CHECKPOINT
			case "payload":
				job.SetPayload("{")
			case "resource":
				job.ResourceId = "other-checkpoint"
			case "work-directory":
				h.executor.checkpointWorkDir = ""
			case "store":
				h.executor.archiveStore = nil
			case "unsupported-scheme":
				h.executor.archiveStore = &storage.SchemeArchiveStore{}
			case "metadata":
				artifact.SizeBytes++
				job = uploadJob(t, artifact)
			}
			h.executor.acknowledgeCheckpointUpload(t.Context(), job)
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("invalid acknowledgment removed archive: %v", err)
			}
		})
	}
}
