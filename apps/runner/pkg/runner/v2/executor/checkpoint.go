// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"errors"
	"fmt"
	sdk "github.com/boxlite-ai/boxlite/sdks/go"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/backend"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

func checkpointJobType(kind apiclient.JobType) bool {
	switch kind {
	case apiclient.JOBTYPE_PAUSE_BOX, apiclient.JOBTYPE_RESUME_BOX, apiclient.JOBTYPE_CREATE_CHECKPOINT, apiclient.JOBTYPE_IMPORT_CHECKPOINT:
		return true
	}
	return false
}

func (e *Executor) checkpoint(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload blclient.CheckpointJob
	if err := e.parsePayload(job.Payload, &payload); err != nil {
		return nil, err
	}
	payload.Kind = string(job.GetType())
	payload.BoxID = job.ResourceId
	result := &blclient.CheckpointResult{OperationID: payload.OperationID, NativeCompleted: true, State: "unknown"}
	runtime, ok := e.backend.(backend.CheckpointBackend)
	if !ok {
		result.Error = &blclient.CheckpointFailure{Type: "UnsupportedError", Code: "unsupported", Message: "runner has no checkpoint backend"}
		return result, fmt.Errorf("%s", result.Error.Message)
	}
	ctx, end, err := e.boxOps.begin(ctx, job.ResourceId)
	if err != nil {
		return nil, err
	}
	defer end()
	stopHeartbeat := e.keepJobAlive(ctx, job.GetId())
	defer stopHeartbeat()
	completed, err := runtime.ExecuteCheckpoint(ctx, payload)
	if completed == nil {
		if err == nil {
			err = fmt.Errorf("checkpoint backend returned no completion")
		}
		// A corrupt/unreadable journal is not evidence that old native work
		// finished. Only preflight input/platform refusals prove no acceptance.
		result.NativeCompleted = false
		if err != nil {
			result.Error = blclient.CheckpointFailureFromError(err)
			var native *sdk.Error
			if errors.As(err, &native) && (native.Code == sdk.ErrUnsupported || native.Code == sdk.ErrInvalidArgument) {
				result.NativeCompleted = true
			}
		}
		return result, err
	}
	return completed, err
}
