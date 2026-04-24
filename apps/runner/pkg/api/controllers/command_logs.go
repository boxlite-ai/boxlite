// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"log/slog"
	"net/http"

	"github.com/daytonaio/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

func ProxyCommandLogsStream(ctx *gin.Context, logger *slog.Logger) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	sandboxId := ctx.Param("sandboxId")
	path := ctx.Param("path")

	result, execErr := r.Boxlite.Exec(ctx.Request.Context(), sandboxId, "echo", path)
	if execErr != nil {
		ctx.JSON(http.StatusBadGateway, gin.H{"error": execErr.Error()})
		return
	}

	ctx.Header("Content-Type", "text/plain")
	ctx.Writer.WriteString(result.StdOut)
}
