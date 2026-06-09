package controllers

import (
	"errors"
	"fmt"
	"net/http"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// Wire-compatible with the SDK's `SnapshotResponse` (Rust side at
// `src/boxlite/src/rest/types.rs`). Field shape MUST stay in sync — the SDK
// deserialises straight onto these names.
type SnapshotInfoResponse struct {
	ID                 string `json:"id"`
	BoxID              string `json:"box_id"`
	Name               string `json:"name"`
	CreatedAt          int64  `json:"created_at"`
	ContainerDiskBytes uint64 `json:"container_disk_bytes"`
	SizeBytes          uint64 `json:"size_bytes"`
}

type ListSnapshotsResponse struct {
	Snapshots []SnapshotInfoResponse `json:"snapshots"`
}

type CreateSnapshotRequest struct {
	Name string `json:"name"`
}

func snapshotInfoToResponse(info *sdkboxlite.SnapshotInfo) SnapshotInfoResponse {
	return SnapshotInfoResponse{
		ID:                 info.ID,
		BoxID:              info.BoxID,
		Name:               info.Name,
		CreatedAt:          info.CreatedAt,
		ContainerDiskBytes: info.ContainerDiskBytes,
		SizeBytes:          info.SizeBytes,
	}
}

// classifySnapshotError mirrors classifyExecError's typed-code switch
// so SDK clients get HTTP shapes consistent across surfaces.
func classifySnapshotError(err error) int {
	var bxErr *sdkboxlite.Error
	if errors.As(err, &bxErr) {
		switch bxErr.Code {
		case sdkboxlite.ErrInvalidArgument, sdkboxlite.ErrInvalidState:
			return http.StatusBadRequest
		case sdkboxlite.ErrNotFound:
			return http.StatusNotFound
		case sdkboxlite.ErrAlreadyExists:
			return http.StatusConflict
		case sdkboxlite.ErrUnsupported, sdkboxlite.ErrUnsupportedEngine:
			return http.StatusNotImplemented
		case sdkboxlite.ErrResourceExhausted:
			return http.StatusTooManyRequests
		}
	}
	return http.StatusInternalServerError
}

func BoxliteSnapshotCreate(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")

	var req CreateSnapshotRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request: %s", err)})
		return
	}
	if req.Name == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}

	info, err := r.Boxlite.SnapshotCreate(ctx.Request.Context(), boxId, req.Name)
	if err != nil {
		ctx.JSON(classifySnapshotError(err), gin.H{"error": fmt.Sprintf("snapshot create failed: %s", err)})
		return
	}
	ctx.JSON(http.StatusCreated, snapshotInfoToResponse(info))
}

func BoxliteSnapshotList(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")

	infos, err := r.Boxlite.SnapshotList(ctx.Request.Context(), boxId)
	if err != nil {
		ctx.JSON(classifySnapshotError(err), gin.H{"error": fmt.Sprintf("snapshot list failed: %s", err)})
		return
	}
	out := ListSnapshotsResponse{Snapshots: make([]SnapshotInfoResponse, 0, len(infos))}
	for i := range infos {
		out.Snapshots = append(out.Snapshots, snapshotInfoToResponse(&infos[i]))
	}
	ctx.JSON(http.StatusOK, out)
}

func BoxliteSnapshotGet(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")
	name := ctx.Param("name")

	info, err := r.Boxlite.SnapshotGet(ctx.Request.Context(), boxId, name)
	if err != nil {
		ctx.JSON(classifySnapshotError(err), gin.H{"error": fmt.Sprintf("snapshot get failed: %s", err)})
		return
	}
	if info == nil {
		ctx.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("snapshot %q not found", name)})
		return
	}
	ctx.JSON(http.StatusOK, snapshotInfoToResponse(info))
}

func BoxliteSnapshotRemove(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")
	name := ctx.Param("name")

	if err := r.Boxlite.SnapshotRemove(ctx.Request.Context(), boxId, name); err != nil {
		ctx.JSON(classifySnapshotError(err), gin.H{"error": fmt.Sprintf("snapshot remove failed: %s", err)})
		return
	}
	ctx.Status(http.StatusNoContent)
}

func BoxliteSnapshotRestore(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")
	name := ctx.Param("name")

	if err := r.Boxlite.SnapshotRestore(ctx.Request.Context(), boxId, name); err != nil {
		ctx.JSON(classifySnapshotError(err), gin.H{"error": fmt.Sprintf("snapshot restore failed: %s", err)})
		return
	}
	ctx.Status(http.StatusNoContent)
}
