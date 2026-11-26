// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"net/http"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/containerd/errdefs"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func protectedAllocationIdentity(ctx *gin.Context) (string, string, bool) {
	boxID, attempt := ctx.Param("boxId"), ctx.Param("attemptId")
	id, err := uuid.Parse(attempt)
	if err != nil || id == uuid.Nil || id.String() != attempt || !protectedBoxID.MatchString(boxID) {
		ctx.Status(http.StatusBadRequest)
		return "", "", false
	}
	return boxID, attempt, true
}

func allocateProtectedPlaceholder(ctx *gin.Context) {
	boxID, attempt, ok := protectedAllocationIdentity(ctx)
	if !ok {
		return
	}
	ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 1<<20)
	var body dto.CreateBoxDTO
	if err := ctx.ShouldBindJSON(&body); err != nil || body.Id != boxID || !validRestartVolumes(body.Volumes) {
		ctx.Status(http.StatusBadRequest)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Status(http.StatusServiceUnavailable)
		return
	}
	if _, err := r.Boxlite.AllocateProtectedPlaceholder(ctx.Request.Context(), body, attempt); err != nil {
		protectedAllocationError(ctx, err)
		return
	}
	ctx.JSON(http.StatusCreated, gin.H{"box_id": boxID, "attempt_id": attempt, "state": "allocated"})
}

func closeProtectedPlaceholder(ctx *gin.Context) {
	boxID, attempt, ok := protectedAllocationIdentity(ctx)
	if !ok {
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Status(http.StatusServiceUnavailable)
		return
	}
	if err := r.Boxlite.CloseProtectedPlaceholder(ctx.Request.Context(), boxID, attempt); err != nil {
		protectedAllocationError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"box_id": boxID, "attempt_id": attempt, "state": "closed"})
}

func protectedAllocationError(ctx *gin.Context, err error) {
	switch {
	case errdefs.IsInvalidArgument(err):
		ctx.Status(http.StatusBadRequest)
	case errdefs.IsFailedPrecondition(err):
		ctx.Status(http.StatusConflict)
	default:
		ctx.Status(http.StatusBadGateway)
	}
}
