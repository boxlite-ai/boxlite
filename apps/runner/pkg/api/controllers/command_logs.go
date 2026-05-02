// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"log/slog"
	"net/http"

	common_errors "github.com/boxlite-labs/common-go/pkg/errors"
	"github.com/gin-gonic/gin"
)

func ProxyCommandLogsStream(ctx *gin.Context, logger *slog.Logger) {
	ctx.Error(common_errors.NewCustomError(
		http.StatusNotImplemented,
		"command log streaming is not supported by the BoxLite shell bridge",
		"NOT_IMPLEMENTED",
	))
}
