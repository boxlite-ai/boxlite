package controllers

import (
	"fmt"
	"net/http"
	"os"
	"strconv"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// queryBool parses an optional bool query param, returning def when absent/blank/invalid.
func queryBool(ctx *gin.Context, key string, def bool) bool {
	v := ctx.Query(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// BoxliteFileUpload (PUT /v1/boxes/:boxId/files?path=&overwrite=) receives a tar
// body, extracts it to a temp dir, and lays its contents at `path` in the box.
// Mirrors the Rust serve handler: stage the tar, then copy_into with
// include_parent=false so the destination is `path` itself.
func BoxliteFileUpload(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")
	destPath := ctx.Query("path")
	if destPath == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "path query parameter required"})
		return
	}
	overwrite := queryBool(ctx, "overwrite", true)

	tmpDir, err := os.MkdirTemp("", "boxlite-upload-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp dir"})
		return
	}
	defer os.RemoveAll(tmpDir)

	if err := extractTar(ctx.Request.Body, tmpDir); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("extract upload tar: %s", err)})
		return
	}

	if err := r.Boxlite.CopyInto(ctx.Request.Context(), boxId, tmpDir, destPath,
		boxlite.WithIncludeParent(false), boxlite.WithOverwrite(overwrite)); err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("copy failed: %s", err)})
		return
	}
	ctx.Status(http.StatusNoContent)
}

// BoxliteFileDownload (GET /v1/boxes/:boxId/files?path=&include_parent=&follow_symlinks=)
// copies `path` out of the box honoring the options, then streams a faithful tar
// (preserving dirs, empty dirs, and symlinks).
func BoxliteFileDownload(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")
	srcPath := ctx.Query("path")
	if srcPath == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "path query parameter required"})
		return
	}
	includeParent := queryBool(ctx, "include_parent", true)
	followSymlinks := queryBool(ctx, "follow_symlinks", false)

	tmpDir, err := os.MkdirTemp("", "boxlite-download-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp dir"})
		return
	}
	defer os.RemoveAll(tmpDir)

	if err := r.Boxlite.CopyOut(ctx.Request.Context(), boxId, srcPath, tmpDir,
		boxlite.WithIncludeParent(includeParent), boxlite.WithFollowSymlinks(followSymlinks)); err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("copy failed: %s", err)})
		return
	}

	ctx.Header("Content-Type", "application/x-tar")
	ctx.Status(http.StatusOK)
	if err := packDir(tmpDir, ctx.Writer); err != nil {
		r.Logger.Error("pack download tar", "box", boxId, "path", srcPath, "err", err)
	}
}
