package controllers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// BoxliteImagePullRequest is the JSON body for POST /v1/images/pull.
//
// Wire-compatible with the SDK's `RestImageBackend::pull_image`
// (`src/boxlite/src/rest/images.rs`) and the API proxy controller —
// keep field names in lockstep, serde drops mismatched fields.
type BoxliteImagePullRequest struct {
	Reference string `json:"reference"`
}

// BoxliteImagePullResponse mirrors the Go SDK's ImagePullResult so the
// SDK can build an ImageObject without a second round-trip.
type BoxliteImagePullResponse struct {
	Reference    string `json:"reference"`
	ConfigDigest string `json:"config_digest"`
	LayerCount   int    `json:"layer_count"`
}

// BoxliteImagePull pulls an OCI image into the runtime's blob cache
// and returns metadata about the cached result. Surfaces real
// errors (registry unreachable, manifest not found, etc.) verbatim
// so the SDK can classify them.
func BoxliteImagePull(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var req BoxliteImagePullRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request body: %s", err)})
		return
	}
	ref := strings.TrimSpace(req.Reference)
	if ref == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "reference is required"})
		return
	}

	result, err := r.Boxlite.PullImage(ctx.Request.Context(), ref)
	if err != nil {
		ctx.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("pull failed: %s", err)})
		return
	}

	ctx.JSON(http.StatusOK, BoxliteImagePullResponse{
		Reference:    result.Reference,
		ConfigDigest: result.ConfigDigest,
		LayerCount:   result.LayerCount,
	})
}
