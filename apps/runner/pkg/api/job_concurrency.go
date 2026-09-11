// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package api

import (
	"net/http"

	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	"github.com/gin-gonic/gin"
)

type JobConcurrency struct {
	MaxConcurrentJobs int `json:"maxConcurrentJobs"`
}

func (a *ApiServer) registerJobConcurrencyRoutes() {
	if a.jobPoller == nil {
		return
	}
	routes := a.router.Group("/config/job-concurrency", middlewares.AuthMiddleware(a.apiToken))
	routes.GET("", a.getJobConcurrency)
	routes.PATCH("", a.updateJobConcurrency)
}

// getJobConcurrency godoc
// @Summary Get the current Runner job concurrency limit
// @Tags config
// @Produce json
// @Success 200 {object} JobConcurrency
// @Security Bearer
// @Router /config/job-concurrency [get]
func (a *ApiServer) getJobConcurrency(ctx *gin.Context) {
	ctx.JSON(http.StatusOK, JobConcurrency{MaxConcurrentJobs: a.jobPoller.MaxConcurrentJobs()})
}

// updateJobConcurrency godoc
// @Summary Update the Runner job concurrency limit until restart
// @Description Applies to API v2 polled jobs. Running jobs finish when lowering the limit.
// @Tags config
// @Accept json
// @Produce json
// @Param config body JobConcurrency true "Positive concurrency limit"
// @Success 200 {object} JobConcurrency
// @Failure 400 {object} map[string]string
// @Security Bearer
// @Router /config/job-concurrency [patch]
func (a *ApiServer) updateJobConcurrency(ctx *gin.Context) {
	var request JobConcurrency
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "maxConcurrentJobs must be a positive integer"})
		return
	}
	if err := a.jobPoller.SetMaxConcurrentJobs(request.MaxConcurrentJobs); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx.JSON(http.StatusOK, request)
}
