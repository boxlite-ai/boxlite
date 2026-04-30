// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0
package controllers

import (
	"net/http"

	"github.com/boxlite-labs/runner/internal"
	"github.com/gin-gonic/gin"
)

// HealthCheck 			godoc
//
//	@Summary		Health check
//	@Description	Health check
//	@Produce		json
//	@Success		200	{object}	map[string]string
//	@Router			/ [get]
//
//	@id				HealthCheck
func HealthCheck(ctx *gin.Context) {
	ctx.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"version": internal.Version,
	})
}
