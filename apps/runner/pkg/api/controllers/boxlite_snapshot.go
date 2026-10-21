package controllers

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// Snapshot requests reserve memory explicitly. No production request can turn
// on a mock, and no unsupported request is downgraded to a filesystem snapshot.
type CreateSnapshotRequest struct {
	Name         string `json:"name"`
	SnapshotType string `json:"snapshot_type"`
}

func snapshotUnsupported(ctx *gin.Context) {
	ctx.JSON(http.StatusNotImplemented, gin.H{"error": gin.H{
		"type": "UnsupportedError", "code": "unsupported",
		"message": "memory save/restore and create-from-snapshot are not implemented by this runner",
	}})
}

func BoxliteCreateSnapshot(ctx *gin.Context) {
	var request CreateSnapshotRequest
	decoder := json.NewDecoder(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 65536))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&request)
	var extra any
	if err != nil || decoder.Decode(&extra) != io.EOF || request.Name == "" ||
		(request.SnapshotType != "" && request.SnapshotType != "filesystem" && request.SnapshotType != "memory") {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "InvalidArgumentError", "code": "invalid_argument", "message": "expected name and snapshot_type filesystem or memory"}})
		return
	}
	if request.SnapshotType == "memory" {
		snapshotUnsupported(ctx)
		return
	}
	box := snapshotBox(ctx)
	if box == nil {
		return
	}
	info, err := box.Snapshots().Create(ctx.Request.Context(), request.Name, request.SnapshotType)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	info.BoxID = ctx.Param("boxId")
	ctx.JSON(http.StatusCreated, info)
}

func BoxliteSnapshotOperation(ctx *gin.Context) {
	snapshotUnsupported(ctx)
}

func BoxliteRuntimeSnapshot(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	if ctx.Request.Method == http.MethodDelete {
		if err := r.Boxlite.SnapshotRemove(ctx.Request.Context(), ctx.Param("snapshot")); err != nil {
			snapshotError(ctx, err)
			return
		}
		ctx.Status(204)
		return
	}
	info, err := r.Boxlite.SnapshotGet(ctx.Request.Context(), ctx.Param("snapshot"))
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	ctx.JSON(200, info)
}

func snapshotBox(ctx *gin.Context) *sdk.Box {
	r, err := runner.GetInstance(nil)
	if err != nil {
		snapshotError(ctx, err)
		return nil
	}
	box, err := r.Boxlite.GetBox(ctx.Request.Context(), ctx.Param("boxId"))
	if err != nil {
		snapshotError(ctx, err)
		return nil
	}
	return box
}

func snapshotError(ctx *gin.Context, err error) {
	slog.WarnContext(ctx.Request.Context(), "snapshot operation failed", "box_id", ctx.Param("boxId"), "error", err)
	status, code := http.StatusInternalServerError, "internal"
	var sdkError *sdk.Error
	if errors.As(err, &sdkError) {
		switch sdkError.Code {
		case sdk.ErrInvalidArgument:
			status, code = 400, "invalid_argument"
		case sdk.ErrNotFound:
			status, code = 404, "not_found"
		case sdk.ErrAlreadyExists:
			status, code = 409, "already_exists"
		case sdk.ErrInvalidState, sdk.ErrStopped:
			status, code = 409, "invalid_state"
		case sdk.ErrUnsupported:
			status, code = 501, "unsupported"
		}
	}
	// Disk paths are private to this runner. Keep the wire error typed and bounded.
	ctx.JSON(status, gin.H{"error": gin.H{"code": code, "message": "snapshot operation failed: " + code}})
}

func BoxliteListSnapshots(ctx *gin.Context) {
	box := snapshotBox(ctx)
	if box == nil {
		return
	}
	infos, err := box.Snapshots().List(ctx.Request.Context())
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	for i := range infos {
		infos[i].BoxID = ctx.Param("boxId")
	}
	ctx.JSON(200, gin.H{"snapshots": infos})
}

func BoxliteGetSnapshot(ctx *gin.Context) {
	box := snapshotBox(ctx)
	if box == nil {
		return
	}
	info, err := box.Snapshots().Get(ctx.Request.Context(), ctx.Param("snapshot"))
	if err != nil {
		snapshotError(ctx, err)
		return
	}
	info.BoxID = ctx.Param("boxId")
	ctx.JSON(200, info)
}

func BoxliteRemoveSnapshot(ctx *gin.Context) {
	box := snapshotBox(ctx)
	if box == nil {
		return
	}
	if err := box.Snapshots().Remove(ctx.Request.Context(), ctx.Param("snapshot")); err != nil {
		snapshotError(ctx, err)
		return
	}
	ctx.Status(204)
}

func BoxliteRestoreSnapshot(ctx *gin.Context) {
	box := snapshotBox(ctx)
	if box == nil {
		return
	}
	if err := box.Snapshots().Restore(ctx.Request.Context(), ctx.Param("snapshot")); err != nil {
		snapshotError(ctx, err)
		return
	}
	ctx.Status(204)
}
