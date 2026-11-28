// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package controllers

import (
	"context"
	"errors"
	"net/http"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	jobexecutor "github.com/boxlite-ai/runner/pkg/runner/v2/executor"
	"github.com/gin-gonic/gin"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

type DirectCreateExecutor interface {
	AcceptDirectCreate(context.Context, *apiclient.Job) error
}

func DirectCreate(executor DirectCreateExecutor) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		var job apiclient.Job
		if err := ctx.ShouldBindJSON(&job); err != nil {
			ctx.Error(common_errors.NewInvalidBodyRequestError(err))
			return
		}
		if job.GetType() != apiclient.JOBTYPE_CREATE_BOX || job.GetId() == "" || job.GetId() != ctx.Param("jobId") {
			ctx.Error(common_errors.NewCustomError(
				http.StatusBadRequest,
				"direct dispatch requires a CREATE_BOX job whose ID matches the path",
				"INVALID_DIRECT_CREATE_JOB",
			))
			return
		}
		if err := executor.AcceptDirectCreate(ctx.Request.Context(), &job); err != nil {
			if errors.Is(err, jobexecutor.ErrDirectCreateCapacity) {
				ctx.Error(common_errors.NewCustomError(
					http.StatusServiceUnavailable,
					"runner direct create capacity is full",
					"DIRECT_CREATE_CAPACITY",
				))
				return
			}
			ctx.Error(err)
			return
		}
		ctx.Status(http.StatusAccepted)
	}
}
