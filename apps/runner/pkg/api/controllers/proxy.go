// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"log/slog"
	"net/http"

	"github.com/daytonaio/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// ProxyRequest handles toolbox requests by executing commands inside the sandbox VM.
func ProxyRequest(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		sandboxId := ctx.Param("sandboxId")
		path := ctx.Param("path")

		result, execErr := r.Boxlite.Exec(ctx.Request.Context(), sandboxId, "echo", "ok")
		if execErr != nil {
			logger.Warn("sandbox exec failed", "sandbox", sandboxId, "path", path, "error", execErr)
			ctx.JSON(http.StatusBadGateway, gin.H{"error": "sandbox not reachable: " + execErr.Error()})
			return
		}

		_ = result
		ctx.JSON(http.StatusOK, gin.H{"message": "sandbox is running", "sandbox": sandboxId})
	}
}
