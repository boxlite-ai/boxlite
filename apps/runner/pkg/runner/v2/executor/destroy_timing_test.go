// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"errors"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/internal/timing"
	"github.com/google/uuid"
)

type destroyTimingBackend struct {
	*checkpointBackend
	retireErr error
	absent    bool
}

func (b destroyTimingBackend) RetireCheckpointTarget(ctx context.Context, boxID string) error {
	if b.retireErr != nil {
		return b.retireErr
	}
	return b.checkpointBackend.RetireCheckpointTarget(ctx, boxID)
}

func (b destroyTimingBackend) Destroy(ctx context.Context, boxID string) error {
	if b.absent {
		// The client has already normalized the SDK's NotFound to nil.
		timing.MarkDestroySkipped(ctx)
	}
	return b.checkpointBackend.Destroy(ctx, boxID)
}

func TestDestroyJobTiming(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		retireErr, destroyErr error
		absent                bool
		finished              string
		jobStatus             apiclient.JobStatus
	}{
		{name: "removed", finished: timing.OK, jobStatus: apiclient.JOBSTATUS_COMPLETED},
		{name: "absent", absent: true, finished: timing.Skipped, jobStatus: apiclient.JOBSTATUS_COMPLETED},
		{name: "backend not found", destroyErr: &boxlite.Error{Code: boxlite.ErrNotFound}, finished: timing.Skipped, jobStatus: apiclient.JOBSTATUS_COMPLETED},
		{name: "failed", destroyErr: errors.New("destroy failed"), finished: timing.Error, jobStatus: apiclient.JOBSTATUS_FAILED},
		{name: "not dispatched", retireErr: errors.New("retire failed"), finished: timing.Error, jobStatus: apiclient.JOBSTATUS_FAILED},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, backend, _ := checkpointHarness(t)
			backend.destroyErr = tc.destroyErr
			h.executor.backend = destroyTimingBackend{checkpointBackend: backend, retireErr: tc.retireErr, absent: tc.absent}
			job := apiclient.NewJob(uuid.NewString(), apiclient.JOBTYPE_DESTROY_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", uuid.NewString(), "2026-11-06T00:00:00Z")
			h.executor.Execute(t.Context(), job)
			if report := h.lastReport(t); report.body.Status != tc.jobStatus {
				t.Fatalf("job reported %s, want %s", report.body.Status, tc.jobStatus)
			}
			type phase struct{ stage, status string }
			want := []phase{{"destroy.dispatched", timing.OK}}
			if tc.retireErr != nil {
				want = []phase{{"destroy.dispatched", timing.Error}, {"destroy.runtime", timing.Skipped}, {"destroy.client", timing.Skipped}}
				if got := h.calls.snapshot(); len(got) != 0 {
					t.Fatalf("backend invoked after failed retirement: %v", got)
				}
			}
			want = append(want, phase{"destroy.finished", tc.finished}, phase{"destroy.job_status", timing.OK})
			got := timing.Snapshot(job.ResourceId)
			if len(got) != len(want) {
				t.Fatalf("events = %+v, want %v", got, want)
			}
			for i, e := range got {
				if e.Op != "destroy" || e.Stage != want[i].stage || e.Status != want[i].status || e.JobID != job.Id || e.BoxID != job.ResourceId {
					t.Fatalf("event = %+v, want %v for job %s", e, want[i], job.Id)
				}
			}
		})
	}
}
