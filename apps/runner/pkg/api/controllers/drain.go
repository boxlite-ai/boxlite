// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"net/http"

	"github.com/boxlite-ai/runner/pkg/drain"
	"github.com/gin-gonic/gin"
)

type DrainRequest struct {
	Draining bool `json:"draining"`
}

type DrainStatusResponse struct {
	Draining          bool  `json:"draining"`
	ActiveAttachCount int64 `json:"active_attach_count"`
}

func DrainStatus(ctx *gin.Context) {
	ctx.JSON(http.StatusOK, drainStatusResponse())
}

func SetDrain(ctx *gin.Context) {
	var req DrainRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}

	if req.Draining {
		drain.Enable()
	} else {
		drain.Disable()
	}

	ctx.JSON(http.StatusOK, drainStatusResponse())
}

func drainStatusResponse() DrainStatusResponse {
	return DrainStatusResponse{
		Draining:          drain.IsDraining(),
		ActiveAttachCount: drain.ActiveAttachCount(),
	}
}
