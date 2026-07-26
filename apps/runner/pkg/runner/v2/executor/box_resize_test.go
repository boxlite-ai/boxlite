/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

package executor

import (
	"context"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/containerd/errdefs"
)

func TestResizeBoxRejectsLegacyJobBeforeBackend(t *testing.T) {
	payload := `{"cpu":4,"memory":8,"disk":20}`
	job := apiclient.NewJob(
		"job-1",
		apiclient.JOBTYPE_RESIZE_BOX,
		apiclient.JOBSTATUS_PENDING,
		"box",
		"box-1",
		"2026-01-01T00:00:00Z",
	)
	job.Payload = &payload

	// A nil backend makes reaching the old mutation path panic. The compatibility
	// sink must reject the job before it attempts any backend operation.
	_, err := (&Executor{}).resizeBox(context.Background(), job)

	if !errdefs.IsNotImplemented(err) {
		t.Fatalf("expected NotImplemented before backend access, got %v", err)
	}
}
