// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package middlewares

import (
	"encoding/json"
	"net/http"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/gin-gonic/gin"
)

func RecoverableErrorsMiddleware() gin.HandlerFunc {
	return func(ctx *gin.Context) {
		ctx.Next()
		errs := ctx.Errors
		if len(errs) > 0 {
			err := errs.Last()
			if common.IsRecoverable(err.Err.Error()) {
				res := map[string]any{
					"errorReason": err.Err.Error() + " - you may attempt a recovery action",
					"recoverable": true,
				}
				b, marshalErr := json.Marshal(res)
				if marshalErr == nil {
					ctx.Errors = []*gin.Error{
						{
							Err:  common_errors.NewCustomError(http.StatusBadRequest, string(b), "BAD_REQUEST"),
							Type: gin.ErrorTypePublic,
						},
					}
				}
			}
		}
	}
}
