// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package middlewares

import (
	"net/http"
	"time"

	"github.com/boxlite-ai/daemon/pkg/common"
	"github.com/gin-gonic/gin"
)

func ErrorMiddleware() gin.HandlerFunc {
	return func(ctx *gin.Context) {
		ctx.Next()

		if len(ctx.Errors) > 0 {
			err := ctx.Errors.Last()
			statusCode := ctx.Writer.Status()

			errorResponse := common.ErrorResponse{
				StatusCode: statusCode,
				Message:    err.Error(),
				Code:       http.StatusText(statusCode),
				Timestamp:  time.Now(),
				Path:       ctx.Request.URL.Path,
				Method:     ctx.Request.Method,
			}

			ctx.Header("Content-Type", "application/json")
			ctx.AbortWithStatusJSON(statusCode, errorResponse)
		}
	}
}
