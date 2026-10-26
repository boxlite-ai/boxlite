/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models"
)

const testArchiveUri = "gs://snapshots/box-snapshots/org-1/snap-1.boxlite"

func TestSnapshotBoxCreationDownloadsBeforeInitializing(t *testing.T) {
	h := newSnapshotHarness(t, nil)
	h.backend.getInfoFn = func() (models.BoxInfo, error) { return models.BoxInfo{}, nil }
	h.backend.createFn = func(_ context.Context, request dto.CreateBoxDTO) (string, string, error) {
		h.calls.record("create:%s", request.Id)
		contents, err := os.ReadFile(request.SnapshotArchivePath)
		if err != nil || string(contents) != "archive" {
			t.Fatalf("Create received no downloaded archive: %q, %v", contents, err)
		}
		return request.Id, "boxlite", nil
	}
	payload := fmt.Sprintf(`{"id":%q,"snapshotArchiveUri":%q}`, testBoxId, testArchiveUri)
	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_CREATE_BOX, payload))
	assertCompleted(t, h.lastReport(t))
	if got := h.calls.snapshot(); !slices.Equal(got, []string{"download:" + testArchiveUri, "create:" + testBoxId}) {
		t.Fatalf("calls = %v", got)
	}
	assertWorkDirEmpty(t, h.workDir)
}

func TestSnapshotBoxCreationDoesNotCreateWhenDownloadFails(t *testing.T) {
	h := newSnapshotHarness(t, func(h *harness) { h.store.downloadErr = fmt.Errorf("object missing") })
	h.backend.getInfoFn = func() (models.BoxInfo, error) { return models.BoxInfo{}, nil }
	payload := fmt.Sprintf(`{"id":%q,"snapshotArchiveUri":%q}`, testBoxId, testArchiveUri)
	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_CREATE_BOX, payload))
	assertFailedWith(t, h.lastReport(t), "object missing")
	if got := h.calls.snapshot(); !slices.Equal(got, []string{"download:" + testArchiveUri}) {
		t.Fatalf("download failure touched backend: %v", got)
	}
	assertWorkDirEmpty(t, h.workDir)
}

func TestSnapshotBoxReplayDoesNotReadDeletedArchiveOrRestartChild(t *testing.T) {
	h := newSnapshotHarness(t, nil)
	h.backend.getInfoFn = func() (models.BoxInfo, error) { return models.BoxInfo{StartedAt: time.Now()}, nil }
	h.store.downloadErr = fmt.Errorf("archive was deleted after creation")
	payload := fmt.Sprintf(`{"id":%q,"snapshotArchiveUri":%q}`, testBoxId, testArchiveUri)
	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_CREATE_BOX, payload))
	assertCompleted(t, h.lastReport(t))
	if got := h.calls.snapshot(); len(got) != 0 {
		t.Fatalf("replay touched %v", got)
	}
}

func newSnapshotHarness(t *testing.T, configure func(*harness)) *harness {
	t.Helper()
	h := newHarness(t, configure)
	h.executor.snapshotWorkDir = h.workDir
	return h
}

func snapshotPayload() string {
	return fmt.Sprintf(`{"archiveUri":%q}`, testArchiveUri)
}

func (h *harness) reports() []reportedStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]reportedStatus(nil), h.reported...)
}

func TestCreateSnapshotUploadsTheExportAndReportsItsSize(t *testing.T) {
	h := newSnapshotHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_CREATE_SNAPSHOT, snapshotPayload()))

	report := h.lastReport(t)
	assertCompleted(t, report)
	if report.body.ResultMetadata == nil || *report.body.ResultMetadata != `{"sizeBytes":7}` {
		t.Fatalf("resultMetadata = %v, want the exported archive's size", report.body.ResultMetadata)
	}
	if h.store.uploadedKey != testArchiveUri {
		t.Fatalf("uploaded to %q, want the assigned %q", h.store.uploadedKey, testArchiveUri)
	}
	if got, want := h.calls.snapshot(), []string{"export:" + testBoxId, "upload:" + testArchiveUri}; !slices.Equal(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	assertWorkDirEmpty(t, h.workDir)
}

func TestRestoreSnapshotSwapsInTheDownloadedArchive(t *testing.T) {
	h := newSnapshotHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_RESTORE_SNAPSHOT, snapshotPayload()))

	assertCompleted(t, h.lastReport(t))
	if !h.backend.archivePresentOnImport {
		t.Fatal("restore ran without the downloaded archive on disk")
	}
	if got, want := h.calls.snapshot(), []string{"download:" + testArchiveUri, "restore:" + testBoxId}; !slices.Equal(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	assertWorkDirEmpty(t, h.workDir)
}

func TestRestoreSnapshotReportsARuntimeRefusal(t *testing.T) {
	h := newSnapshotHarness(t, func(h *harness) {
		h.backend.importErr = fmt.Errorf("container disk checksum mismatch")
	})

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_RESTORE_SNAPSHOT, snapshotPayload()))

	assertFailedWith(t, h.lastReport(t), "checksum mismatch")
	assertWorkDirEmpty(t, h.workDir)
}

func TestSnapshotJobsRequireTheAssignedArchive(t *testing.T) {
	h := newSnapshotHarness(t, nil)

	h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_CREATE_SNAPSHOT, `{}`))

	assertFailedWith(t, h.lastReport(t), "archiveUri is required")
	if calls := h.calls.snapshot(); len(calls) != 0 {
		t.Fatalf("a job without its archive touched %v", calls)
	}
}

// Deleting a box mid-snapshot must not remove the disk the runtime is still
// reading or replacing. The SDK call returns on cancellation while the runtime
// goes on, so the destroy has to wait for the runtime itself; the snapshot job
// then reports the cancellation.
func TestDestroyWaitsForTheRuntimeToLetGoOfTheDisk(t *testing.T) {
	for _, tc := range []struct {
		name    string
		jobType apiclient.JobType
		hold    func(*fakeBackend) chan struct{}
		started string
		calls   []string
	}{
		{
			name:    "export",
			jobType: apiclient.JOBTYPE_CREATE_SNAPSHOT,
			hold: func(b *fakeBackend) chan struct{} {
				b.exportBlock = make(chan struct{})
				return b.exportBlock
			},
			started: "export:" + testBoxId,
			calls:   []string{"export:" + testBoxId, "exported:" + testBoxId, "destroy:" + testBoxId},
		},
		{
			name:    "restore",
			jobType: apiclient.JOBTYPE_RESTORE_SNAPSHOT,
			hold: func(b *fakeBackend) chan struct{} {
				b.restoreBlock = make(chan struct{})
				return b.restoreBlock
			},
			started: "restore:" + testBoxId,
			calls:   []string{"download:" + testArchiveUri, "restore:" + testBoxId, "restored:" + testBoxId, "destroy:" + testBoxId},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var release chan struct{}
			h := newSnapshotHarness(t, func(h *harness) { release = tc.hold(h.backend) })

			snapshotDone := make(chan struct{})
			go func() {
				defer close(snapshotDone)
				h.executor.Execute(context.Background(), migrateJob(tc.jobType, snapshotPayload()))
			}()
			waitFor(t, func() bool { return slices.Contains(h.calls.snapshot(), tc.started) })

			destroyDone := make(chan struct{})
			go func() {
				defer close(destroyDone)
				h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_DESTROY_BOX, ""))
			}()
			// Ample time for a destroy that does not wait to remove the box.
			time.Sleep(200 * time.Millisecond)
			if slices.Contains(h.calls.snapshot(), "destroy:"+testBoxId) {
				t.Fatalf("the box was destroyed while the runtime still held its disk: %v", h.calls.snapshot())
			}

			close(release)
			<-destroyDone
			<-snapshotDone

			if got := h.calls.snapshot(); !slices.Equal(got, tc.calls) {
				t.Fatalf("calls = %v, want %v", got, tc.calls)
			}
			// Both jobs report concurrently once the runtime has let go, so
			// match the reports by outcome rather than by arrival order.
			reports := h.reports()
			if len(reports) != 2 {
				t.Fatalf("expected the snapshot job and the destroy to report, got %d reports", len(reports))
			}
			failed := slices.IndexFunc(reports, func(r reportedStatus) bool { return r.body.Status == apiclient.JOBSTATUS_FAILED })
			if failed < 0 {
				t.Fatalf("the cancelled snapshot job did not report a failure: %+v", reports)
			}
			assertFailedWith(t, reports[failed], "context canceled")
			if other := reports[1-failed]; other.body.Status != apiclient.JOBSTATUS_COMPLETED {
				t.Fatalf("destroy status = %s, want COMPLETED", other.body.Status)
			}
		})
	}
}

// A snapshot of a large disk outlives the API's ten-minute stale-job sweep,
// so the job has to keep saying it is alive until it finishes.
func TestSnapshotJobsReportProgressWhileRunning(t *testing.T) {
	h := newSnapshotHarness(t, func(h *harness) {
		h.backend.restoreBlock = make(chan struct{})
	})
	h.executor.heartbeatInterval = 10 * time.Millisecond

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.executor.Execute(context.Background(), migrateJob(apiclient.JOBTYPE_RESTORE_SNAPSHOT, snapshotPayload()))
	}()
	waitFor(t, func() bool { return len(h.reports()) >= 2 })
	close(h.backend.restoreBlock)
	<-done

	reports := h.reports()
	for _, report := range reports[:len(reports)-1] {
		if report.body.Status != apiclient.JOBSTATUS_IN_PROGRESS {
			t.Fatalf("heartbeat status = %s, want IN_PROGRESS", report.body.Status)
		}
	}
	assertCompleted(t, reports[len(reports)-1])
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the job to get there")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
