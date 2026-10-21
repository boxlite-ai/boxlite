package controllers

import (
	"encoding/json"
	"io"
	"net/http"

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
		"message": "snapshot operations are not implemented by this runner; memory save/restore is unsupported",
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
	snapshotUnsupported(ctx)
}

func BoxliteSnapshotOperation(ctx *gin.Context) {
	snapshotUnsupported(ctx)
}
