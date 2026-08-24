/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

const (
	testBoxId   = "box-1"
	testJobId   = "job-1"
	testArcPath = "migrate/box-1/job-1.boxlite"
)

// --- fakes -------------------------------------------------------------------

// callLog records the order in which the backend and the object store were
// used, so a test can assert the sequence a job is required to follow.
type callLog struct {
	mu      sync.Mutex
	entries []string
}

func (c *callLog) record(format string, args ...any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = append(c.entries, fmt.Sprintf(format, args...))
}

func (c *callLog) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.entries...)
}

// fakeBackend stands in for the boxlite runtime. Every method the migration
// jobs must not touch fails loudly rather than returning a zero value.
type fakeBackend struct {
	calls *callLog

	exportedArchiveName string
	exportErr           error

	importErr error
	// archivePresentOnImport records whether the downloaded archive was on disk
	// at the moment the import ran — the import is worthless without it.
	archivePresentOnImport bool

	destroyErr error
}

func (f *fakeBackend) ExportBox(_ context.Context, boxId, destDir string) (string, error) {
	f.calls.record("export:%s", boxId)
	if f.exportErr != nil {
		return "", f.exportErr
	}

	archivePath := filepath.Join(destDir, f.exportedArchiveName)
	if err := os.WriteFile(archivePath, []byte("archive"), 0600); err != nil {
		return "", err
	}
	return archivePath, nil
}

func (f *fakeBackend) ImportBox(_ context.Context, boxId, archivePath string) error {
	f.calls.record("import:%s", boxId)
	_, statErr := os.Stat(archivePath)
	f.archivePresentOnImport = statErr == nil
	return f.importErr
}

func (f *fakeBackend) Create(context.Context, dto.CreateBoxDTO) (string, string, error) {
	return "", "", fmt.Errorf("Create must not be called by a migration job")
}

func (f *fakeBackend) Start(context.Context, string, *string, map[string]string) (string, error) {
	return "", fmt.Errorf("Start must not be called by a migration job")
}

func (f *fakeBackend) Stop(context.Context, string, bool) error {
	return fmt.Errorf("Stop must not be called by a migration job")
}

func (f *fakeBackend) Destroy(_ context.Context, boxId string) error {
	f.calls.record("destroy:%s", boxId)
	return f.destroyErr
}

func (f *fakeBackend) RecoverBox(context.Context, string, dto.RecoverBoxDTO) error {
	return fmt.Errorf("RecoverBox must not be called by a migration job")
}

func (f *fakeBackend) UpdateNetworkSettings(context.Context, string, dto.UpdateNetworkSettingsDTO) error {
	return fmt.Errorf("UpdateNetworkSettings must not be called by a migration job")
}

func (f *fakeBackend) GetBoxState(context.Context, string) (enums.BoxState, error) {
	return enums.BoxStateUnknown, fmt.Errorf("GetBoxState must not be called by a migration job")
}

func (f *fakeBackend) Ping(context.Context) error {
	return fmt.Errorf("Ping must not be called by a migration job")
}

// fakeArchiveStore stands in for the S3 bucket the archive travels through.
type fakeArchiveStore struct {
	calls *callLog

	uploadErr   error
	downloadErr error
	removeErr   error

	uploadedKey   string
	uploadedBytes []byte
	downloadedKey string
	removedKeys   []string
}

func (f *fakeArchiveStore) Upload(_ context.Context, key, localPath string) error {
	f.calls.record("upload:%s", key)
	if f.uploadErr != nil {
		return f.uploadErr
	}

	content, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	f.uploadedKey = key
	f.uploadedBytes = content
	return nil
}

func (f *fakeArchiveStore) Download(_ context.Context, key, localPath string) error {
	f.calls.record("download:%s", key)
	if f.downloadErr != nil {
		return f.downloadErr
	}

	f.downloadedKey = key
	return os.WriteFile(localPath, []byte("archive"), 0600)
}

func (f *fakeArchiveStore) Remove(_ context.Context, key string) error {
	f.calls.record("remove:%s", key)
	if f.removeErr != nil {
		return f.removeErr
	}

	f.removedKeys = append(f.removedKeys, key)
	return nil
}

// --- harness -----------------------------------------------------------------

// reportedStatus is what the runner POSTed to /jobs/{jobId}/status.
type reportedStatus struct {
	method string
	path   string
	body   apiclient.UpdateJobStatus
}

type harness struct {
	executor *Executor
	backend  *fakeBackend
	store    *fakeArchiveStore
	calls    *callLog
	workDir  string

	mu       sync.Mutex
	reported []reportedStatus
}

func newHarness(t *testing.T, configure func(*harness)) *harness {
	t.Helper()

	calls := &callLog{}
	h := &harness{
		backend: &fakeBackend{calls: calls, exportedArchiveName: testBoxId + ".boxlite"},
		store:   &fakeArchiveStore{calls: calls},
		calls:   calls,
		workDir: t.TempDir(),
	}
	if configure != nil {
		configure(h)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body apiclient.UpdateJobStatus
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("status callback body is not UpdateJobStatus JSON: %v", err)
		}

		h.mu.Lock()
		h.reported = append(h.reported, reportedStatus{method: r.Method, path: r.URL.Path, body: body})
		h.mu.Unlock()

		// The real endpoint echoes the updated job. The runner ignores it, but
		// the generated client insists on decoding it, and a response it cannot
		// decode would be retried — which would hide how many callbacks a job
		// actually made.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"id":%q,"type":"EXPORT_BOX","status":%q,"resourceType":"backup","resourceId":%q,"createdAt":"2026-01-01T00:00:00Z"}`,
			testJobId, body.Status, testBoxId)
	}))
	t.Cleanup(server.Close)

	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers = apiclient.ServerConfigurations{{URL: server.URL}}

	h.executor = &Executor{
		log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		client:         apiclient.NewAPIClient(clientConfig),
		backend:        h.backend,
		migrateWorkDir: h.workDir,
	}
	// Assigned only when set, so a test that drops the store leaves the executor
	// holding a nil interface rather than a typed nil the guard would miss.
	if h.store != nil {
		h.executor.archiveStore = h.store
	}

	return h
}

func (h *harness) lastReport(t *testing.T) reportedStatus {
	t.Helper()

	h.mu.Lock()
	defer h.mu.Unlock()

	if len(h.reported) != 1 {
		t.Fatalf("expected exactly one status callback, got %d", len(h.reported))
	}
	return h.reported[0]
}

func migrateJob(jobType apiclient.JobType, payload string) *apiclient.Job {
	job := apiclient.NewJob(testJobId, jobType, apiclient.JOBSTATUS_IN_PROGRESS, "box", testBoxId, "2026-01-01T00:00:00Z")
	if payload != "" {
		job.Payload = &payload
	}
	return job
}

func arcPathPayload() string {
	return fmt.Sprintf(`{"arcPath":%q}`, testArcPath)
}

func assertCompleted(t *testing.T, report reportedStatus) {
	t.Helper()

	if report.method != http.MethodPost || report.path != "/jobs/"+testJobId+"/status" {
		t.Fatalf("status callback = %s %s, want POST /jobs/%s/status", report.method, report.path, testJobId)
	}
	if report.body.Status != apiclient.JOBSTATUS_COMPLETED {
		t.Fatalf("status = %s (error %v), want COMPLETED", report.body.Status, report.body.ErrorMessage)
	}
}

func assertFailedWith(t *testing.T, report reportedStatus, wantErrorFragment string) {
	t.Helper()

	if report.body.Status != apiclient.JOBSTATUS_FAILED {
		t.Fatalf("status = %s, want FAILED", report.body.Status)
	}
	if report.body.ErrorMessage == nil {
		t.Fatal("FAILED status reported without an errorMessage")
	}
	if !strings.Contains(*report.body.ErrorMessage, wantErrorFragment) {
		t.Fatalf("errorMessage = %q, want it to contain %q", *report.body.ErrorMessage, wantErrorFragment)
	}
}

func assertWorkDirEmpty(t *testing.T, dir string) {
	t.Helper()

	leftovers, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read work dir: %v", err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("migration work dir still holds %d file(s); the archive was not cleaned up", len(leftovers))
	}
}

// --- EXPORT_BOX --------------------------------------------------------------

func TestExportBoxUploadsArchiveAndReportsArcPath(t *testing.T) {
	h := newHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_EXPORT_BOX, arcPathPayload()))

	report := h.lastReport(t)
	assertCompleted(t, report)

	if h.store.uploadedKey != testArcPath {
		t.Fatalf("uploaded key = %q, want %q", h.store.uploadedKey, testArcPath)
	}
	if string(h.store.uploadedBytes) != "archive" {
		t.Fatalf("uploaded content = %q, want the exported archive", h.store.uploadedBytes)
	}

	if report.body.ResultMetadata == nil {
		t.Fatal("EXPORT_BOX reported no resultMetadata; the control plane has no arcPath to record")
	}
	var result MigrateArchiveResult
	if err := json.Unmarshal([]byte(*report.body.ResultMetadata), &result); err != nil {
		t.Fatalf("resultMetadata is not MigrateArchiveResult JSON: %v", err)
	}
	if result.ArcPath != testArcPath {
		t.Fatalf("resultMetadata.arcPath = %q, want %q", result.ArcPath, testArcPath)
	}

	assertWorkDirEmpty(t, h.workDir)
}

func TestExportBoxFailsJobWhenUploadFails(t *testing.T) {
	h := newHarness(t, func(h *harness) {
		h.store.uploadErr = fmt.Errorf("bucket unreachable")
	})

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_EXPORT_BOX, arcPathPayload()))

	assertFailedWith(t, h.lastReport(t), "bucket unreachable")
	// The archive never reached the store, so nothing may be left claiming disk.
	assertWorkDirEmpty(t, h.workDir)
}

func TestExportBoxFailsBeforePackingWhenStoreIsUnconfigured(t *testing.T) {
	h := newHarness(t, func(h *harness) { h.store = nil })

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_EXPORT_BOX, arcPathPayload()))

	assertFailedWith(t, h.lastReport(t), "archive store is not configured")
	if calls := h.calls.snapshot(); len(calls) != 0 {
		t.Fatalf("backend was used despite an unusable object store: %v", calls)
	}
}

func TestExportBoxRejectsJobWithoutArcPath(t *testing.T) {
	h := newHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_EXPORT_BOX, `{}`))

	assertFailedWith(t, h.lastReport(t), "arcPath is required")
	if calls := h.calls.snapshot(); len(calls) != 0 {
		t.Fatalf("backend was used for a job with no archive key: %v", calls)
	}
}

// --- IMPORT_BOX --------------------------------------------------------------

func TestImportBoxRestoresBoxFromDownloadedArchive(t *testing.T) {
	h := newHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_IMPORT_BOX, arcPathPayload()))

	report := h.lastReport(t)
	assertCompleted(t, report)

	if h.store.downloadedKey != testArcPath {
		t.Fatalf("downloaded key = %q, want %q", h.store.downloadedKey, testArcPath)
	}
	if !h.backend.archivePresentOnImport {
		t.Fatal("the archive was not on disk when the import ran")
	}
	if want := []string{"download:" + testArcPath, "import:" + testBoxId}; !equalCalls(h.calls.snapshot(), want) {
		t.Fatalf("call order = %v, want %v", h.calls.snapshot(), want)
	}

	// The target runner is the runner the control plane submitted the job to,
	// so IMPORT_BOX has nothing of its own to report back.
	if report.body.ResultMetadata != nil {
		t.Fatalf("IMPORT_BOX reported resultMetadata %q, want none", *report.body.ResultMetadata)
	}

	assertWorkDirEmpty(t, h.workDir)
}

func TestImportBoxDoesNotImportWhenDownloadFails(t *testing.T) {
	h := newHarness(t, func(h *harness) {
		h.store.downloadErr = fmt.Errorf("object missing")
	})

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_IMPORT_BOX, arcPathPayload()))

	assertFailedWith(t, h.lastReport(t), "object missing")
	if want := []string{"download:" + testArcPath}; !equalCalls(h.calls.snapshot(), want) {
		t.Fatalf("call order = %v, want %v — an import must not run without an archive", h.calls.snapshot(), want)
	}
}

func TestImportBoxRemovesLocalArchiveWhenImportFails(t *testing.T) {
	h := newHarness(t, func(h *harness) {
		h.backend.importErr = fmt.Errorf("import rejected")
	})

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_IMPORT_BOX, arcPathPayload()))

	assertFailedWith(t, h.lastReport(t), "import rejected")
	assertWorkDirEmpty(t, h.workDir)
}

// --- ROLLBACK_EXPORT_BOX / ROLLBACK_IMPORT_BOX -------------------------------

func TestRollbackExportBoxRemovesTheArchive(t *testing.T) {
	h := newHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_ROLLBACK_EXPORT_BOX, arcPathPayload()))

	assertCompleted(t, h.lastReport(t))
	if want := []string{testArcPath}; !equalCalls(h.store.removedKeys, want) {
		t.Fatalf("removed keys = %v, want %v", h.store.removedKeys, want)
	}
}

func TestRollbackImportBoxDestroysTheShadowBox(t *testing.T) {
	h := newHarness(t, nil)

	// No payload: the shadow box is addressed by the job's resource id, and the
	// rollback of an import has no archive of its own to reclaim.
	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_ROLLBACK_IMPORT_BOX, ""))

	assertCompleted(t, h.lastReport(t))
	if want := []string{"destroy:" + testBoxId}; !equalCalls(h.calls.snapshot(), want) {
		t.Fatalf("call order = %v, want %v", h.calls.snapshot(), want)
	}
}

// --- DISCARD_EXPORTED_BOX ----------------------------------------------------

func TestDiscardExportedBoxRemovesArchiveThenDestroysBox(t *testing.T) {
	h := newHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_DISCARD_EXPORTED_BOX, arcPathPayload()))

	assertCompleted(t, h.lastReport(t))
	if want := []string{"remove:" + testArcPath, "destroy:" + testBoxId}; !equalCalls(h.calls.snapshot(), want) {
		t.Fatalf("call order = %v, want %v", h.calls.snapshot(), want)
	}
}

func TestDiscardExportedBoxKeepsBoxWhenArchiveRemovalFails(t *testing.T) {
	h := newHarness(t, func(h *harness) {
		h.store.removeErr = fmt.Errorf("bucket unreachable")
	})

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_DISCARD_EXPORTED_BOX, arcPathPayload()))

	assertFailedWith(t, h.lastReport(t), "bucket unreachable")
	// Destroying the box while the archive is still stranded would leave the
	// control plane with a key it can no longer tie to a live box.
	if want := []string{"remove:" + testArcPath}; !equalCalls(h.calls.snapshot(), want) {
		t.Fatalf("call order = %v, want %v", h.calls.snapshot(), want)
	}
}

func equalCalls(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
