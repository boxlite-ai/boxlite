package controllers

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

const snapshotArchiveLimit = 8 << 30
const snapshotArchitectureHeader = "X-Boxlite-Architecture"

// BoxliteExportSnapshot serves only an immutable snapshot addressed by native ID.
// The API authenticates tenant ownership before invoking this runner-only route.
func BoxliteExportSnapshot(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	dir, err := r.Boxlite.SnapshotTransferDir()
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	defer os.RemoveAll(dir)
	path, err := r.Boxlite.SnapshotExport(ctx.Request.Context(), ctx.Param("snapshot"), dir)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	if stat.Size() > snapshotArchiveLimit {
		ctx.JSON(413, gin.H{"error": gin.H{"code": "invalid_argument", "message": "snapshot archive exceeds 8 GiB"}})
		return
	}
	ctx.Header(snapshotArchitectureHeader, runtime.GOARCH)
	ctx.DataFromReader(200, stat.Size(), "application/vnd.boxlite.archive", file, nil)
}

func BoxliteImportSnapshot(ctx *gin.Context) {
	// Check before resolving the runtime, reading large input or importing disks.
	if ctx.GetHeader(snapshotArchitectureHeader) != runtime.GOARCH {
		ctx.JSON(501, gin.H{"error": gin.H{"code": "unsupported", "message": "snapshot architecture is incompatible"}})
		return
	}
	name := ctx.Param("name")
	if name == "" {
		ctx.Status(400)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	dir, err := r.Boxlite.SnapshotTransferDir()
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "snapshot.boxlite")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	_, readErr := io.Copy(file, http.MaxBytesReader(ctx.Writer, ctx.Request.Body, snapshotArchiveLimit))
	err = errors.Join(readErr, file.Close())
	if err != nil {
		ctx.JSON(400, gin.H{"error": gin.H{"code": "invalid_argument", "message": "incomplete or oversized snapshot archive"}})
		return
	}
	info, err := r.Boxlite.SnapshotImport(ctx.Request.Context(), path, name)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	ctx.JSON(201, info)
}
