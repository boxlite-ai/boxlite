package controllers

import (
	"errors"
	"net/http"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

func BoxliteCache(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	var result any
	if err == nil {
		if ctx.Request.Method == http.MethodDelete {
			var cutoff *time.Time
			if value := ctx.Query("idle_before"); value != "" {
				var parsed time.Time
				parsed, err = time.Parse(time.RFC3339, value)
				cutoff = &parsed
				if err != nil {
					err = &sdk.Error{Code: sdk.ErrInvalidArgument, Message: "invalid idle_before"}
				}
			}
			if err == nil {
				err = r.Boxlite.CacheRemove(ctx, ctx.Param("tenant"), ctx.Param("cache"), cutoff)
			}
		} else {
			result, err = r.Boxlite.CacheGet(ctx, ctx.Param("tenant"), ctx.Param("cache"))
		}
	}
	if err != nil {
		status, code := 500, "internal"
		var native *sdk.Error
		if errors.As(err, &native) {
			switch native.Code {
			case sdk.ErrNotFound:
				status, code = 404, "not_found"
			case sdk.ErrInvalidArgument:
				status, code = 400, "invalid_argument"
			case sdk.ErrInvalidState:
				status, code = 409, "invalid_state"
			}
		}
		ctx.JSON(status, gin.H{"error": gin.H{"code": code, "message": "cache operation failed: " + code}})
		return
	}
	if ctx.Request.Method == http.MethodDelete {
		ctx.Status(204)
	} else {
		ctx.JSON(200, result)
	}
}
