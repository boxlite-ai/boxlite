package controllers

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// Wire-compatible with the SDK's BoxResponse — clone/import return a
// box record the SDK can use to build a new RestBox handle. Only the
// fields the SDK deserialises onto matter; others (cpus, memory_mib,
// labels) get defaults and the SDK back-fills via a follow-up GET.
type cloneOrImportResponse struct {
	BoxID     string `json:"box_id"`
	Name      string `json:"name,omitempty"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Image     string `json:"image"`
	Cpus      int    `json:"cpus"`
	MemoryMib int    `json:"memory_mib"`
}

type cloneBoxRequest struct {
	Name string `json:"name"`
}

func classifyCloneExportError(err error) int {
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

func BoxliteCloneBox(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")

	var req cloneBoxRequest
	// Body optional — anonymous clones are valid.
	_ = ctx.ShouldBindJSON(&req)

	cloned, err := r.Boxlite.CloneBox(ctx.Request.Context(), boxId, req.Name)
	if err != nil {
		ctx.JSON(classifyCloneExportError(err), gin.H{"error": fmt.Sprintf("clone failed: %s", err)})
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ctx.JSON(http.StatusCreated, cloneOrImportResponse{
		BoxID:     cloned.ID(),
		Name:      cloned.Name(),
		Status:    "configured",
		CreatedAt: now,
		UpdatedAt: now,
	})
}

// BoxliteExportBox writes the box's disks to a `.boxlite` archive in a
// runner-local temp dir, then streams the archive bytes back to the SDK
// as the response body. The SDK persists those bytes at its caller-
// chosen host path.
func BoxliteExportBox(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	boxId := ctx.Param("boxId")

	tmpDir, err := os.MkdirTemp("", "boxlite-export-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("temp dir: %s", err)})
		return
	}
	defer os.RemoveAll(tmpDir)

	dest := filepath.Join(tmpDir, "out.boxlite")
	if err := r.Boxlite.ExportBox(ctx.Request.Context(), boxId, dest); err != nil {
		ctx.JSON(classifyCloneExportError(err), gin.H{"error": fmt.Sprintf("export failed: %s", err)})
		return
	}

	f, err := os.Open(dest)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("open archive: %s", err)})
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("stat archive: %s", err)})
		return
	}
	ctx.Header("Content-Type", "application/octet-stream")
	ctx.Header("Content-Length", fmt.Sprintf("%d", st.Size()))
	ctx.Status(http.StatusOK)
	if _, err := io.Copy(ctx.Writer, f); err != nil {
		// Headers already sent — can only log.
		fmt.Printf("export stream copy failed: %s\n", err)
	}
}

// BoxliteImportBox reads the request body (archive bytes), persists to a
// runner-local temp file, then calls runtime.ImportBox. Returns the new
// box's record so the SDK can construct a RestBox handle.
func BoxliteImportBox(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	name := ctx.Query("name")

	tmpDir, err := os.MkdirTemp("", "boxlite-import-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("temp dir: %s", err)})
		return
	}
	defer os.RemoveAll(tmpDir)

	archivePath := filepath.Join(tmpDir, "in.boxlite")
	f, err := os.Create(archivePath)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("create archive: %s", err)})
		return
	}
	if _, err := io.Copy(f, ctx.Request.Body); err != nil {
		f.Close()
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("read body: %s", err)})
		return
	}
	f.Close()

	imported, err := r.Boxlite.ImportBox(ctx.Request.Context(), archivePath, name)
	if err != nil {
		ctx.JSON(classifyCloneExportError(err), gin.H{"error": fmt.Sprintf("import failed: %s", err)})
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ctx.JSON(http.StatusCreated, cloneOrImportResponse{
		BoxID:     imported.ID(),
		Name:      imported.Name(),
		Status:    "configured",
		CreatedAt: now,
		UpdatedAt: now,
	})
}
