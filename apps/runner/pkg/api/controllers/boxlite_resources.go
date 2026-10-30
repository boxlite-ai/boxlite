package controllers

import (
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"net/http"
	"runtime"
)

// BoxliteResources is authenticated, read-only preflight for the leased job protocol.
func BoxliteResources(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil || r.Boxlite == nil || runtime.GOOS != "linux" {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "resize jobs are unavailable"})
		return
	}
	resources, err := r.Boxlite.ResizeResources(ctx.Request.Context(), ctx.Param("boxId"), 0, 0)
	if err != nil {
		ctx.JSON(http.StatusConflict, gin.H{"error": "cannot query running box resources"})
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"resize_jobs_v1": true, "resources": resources})
}
