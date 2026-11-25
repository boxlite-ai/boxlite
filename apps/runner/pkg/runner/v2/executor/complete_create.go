// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"context"
	"errors"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
)

type completeCreateBackend interface {
	CreateCompleteOutbound(context.Context, string, dto.CompleteCreateRequest) (dto.CompleteCreateResult, error)
	CancelCompleteOutboundCreate(context.Context, string, dto.CompleteCreateAttempt) (dto.CompleteCreateResult, error)
}

// ExecuteCompleteCreate reports only terminal evidence from the shared Runner
// target journal and Runtime readback. Ambiguity is owned by Cloud recovery.
func (e *Executor) ExecuteCompleteCreate(ctx context.Context, lease string, request dto.CompleteCreateRequest) {
	owner := request.Attempt
	if !sdk.ValidOutboundRevision(owner.JobID) || !sdk.ValidOutboundRevision(owner.ClaimID) ||
		owner.Incarnation != request.Box.Id {
		e.log.WarnContext(ctx, "Invalid complete create claim")
		return
	}
	backend, ok := e.backend.(completeCreateBackend)
	if !ok {
		e.log.WarnContext(ctx, "Runtime does not support complete create")
		return
	}
	unlock := e.lockBox(request.Box.Id)
	defer unlock()
	receipt, err := backend.CreateCompleteOutbound(ctx, request.Box.Id, request)
	var runtimeError *sdk.Error
	if errors.As(err, &runtimeError) && runtimeError.Code == sdk.ErrUnsupported {
		receipt, err = backend.CancelCompleteOutboundCreate(ctx, request.Box.Id, owner)
	}
	if err != nil || (receipt.Outcome != dto.CompleteCreateInstalled && receipt.Outcome != dto.CompleteCreateNoEffect) {
		e.log.WarnContext(ctx, "Complete create awaits reconciliation", "job_id", owner.JobID)
		return
	}
	if err := runnerapiclient.ReportCompleteCreate(ctx, e.client, lease, receipt); err != nil {
		e.log.WarnContext(ctx, "Complete create receipt awaits reconciliation", "job_id", owner.JobID, "error", err)
	}
}
