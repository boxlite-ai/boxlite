package controllers

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

func BoxliteFileUpload(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		respondError(ctx, http.StatusInternalServerError, err.Error(), "InternalError", "internal")
		return
	}

	boxId := ctx.Param("boxId")
	destPath := ctx.Query("path")
	if destPath == "" {
		respondError(ctx, http.StatusBadRequest, "path query parameter required", "InvalidArgumentError", "invalid_argument")
		return
	}

	// The SDK uploads a tar archive (Content-Type: application/x-tar) so
	// that copy_in(host_dir, ...) can move trees in a single request.
	// We MUST extract the archive into a staging dir on the runner host
	// before handing it to the Go SDK's CopyInto — that lower-level call
	// expects a *real path*, not a tar file, and would otherwise dump the
	// entire .tar blob into the guest as a single binary file (which
	// silently breaks both single-file and directory uploads).
	stagingDir, err := os.MkdirTemp("", "boxlite-upload-stage-*")
	if err != nil {
		respondError(ctx, http.StatusInternalServerError, "failed to create staging dir", "InternalError", "internal")
		return
	}
	defer os.RemoveAll(stagingDir)

	stagedPath, isSingleFile, err := extractTarToDir(ctx.Request.Body, stagingDir)
	if err != nil {
		respondError(ctx, http.StatusBadRequest, fmt.Sprintf("failed to extract upload tar: %s", err), "InvalidArgumentError", "invalid_argument")
		return
	}

	// If the archive contained exactly one regular file, CopyInto its
	// extracted path (a real file) so the guest sees the file at destPath.
	// Otherwise CopyInto the staging dir as a whole — the Go SDK's
	// recursive copy handles directories natively.
	src := stagingDir
	if isSingleFile {
		src = stagedPath
	}

	if err := r.Boxlite.CopyInto(ctx.Request.Context(), boxId, src, destPath); err != nil {
		respondCopyError(ctx, err)
		return
	}

	ctx.Status(http.StatusNoContent)
}

// extractTarToDir reads a tar archive from r and writes every entry into
// destDir, preserving the relative layout. Returns:
//   - lastFilePath: path to the most-recently extracted file (only
//     meaningful when isSingleFile is true)
//   - isSingleFile: true when the archive contained exactly one regular
//     file entry (no directories, no symlinks, no multi-file payload).
//     This is the canonical signal for "the caller copy_in'd a single
//     file" so the upload handler can pass that exact path on to
//     CopyInto, rather than passing a wrapping directory.
//
// Entries with paths that escape destDir (zip-slip) are refused.
func extractTarToDir(r io.Reader, destDir string) (lastFilePath string, isSingleFile bool, err error) {
	tr := tar.NewReader(r)
	fileCount := 0
	otherCount := 0 // dirs, symlinks, anything that's not a regular file

	for {
		header, hdrErr := tr.Next()
		if hdrErr == io.EOF {
			break
		}
		if hdrErr != nil {
			return "", false, fmt.Errorf("tar.Next: %w", hdrErr)
		}

		// Defend against absolute paths and traversal — the SDK should
		// only ever send relative entries, but a malformed client could
		// craft an archive that writes outside destDir.
		cleanName := filepath.Clean(header.Name)
		if filepath.IsAbs(cleanName) || cleanName == ".." || (len(cleanName) >= 3 && cleanName[:3] == "../") {
			return "", false, fmt.Errorf("tar entry escapes staging dir: %q", header.Name)
		}
		target := filepath.Join(destDir, cleanName)

		switch header.Typeflag {
		case tar.TypeDir:
			if mkErr := os.MkdirAll(target, 0o755); mkErr != nil {
				return "", false, fmt.Errorf("mkdir %s: %w", target, mkErr)
			}
			otherCount++
		case tar.TypeReg, tar.TypeRegA:
			if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
				return "", false, fmt.Errorf("mkdir parent of %s: %w", target, mkErr)
			}
			f, openErr := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode&0o7777))
			if openErr != nil {
				return "", false, fmt.Errorf("create %s: %w", target, openErr)
			}
			if _, copyErr := io.Copy(f, tr); copyErr != nil {
				f.Close()
				return "", false, fmt.Errorf("write %s: %w", target, copyErr)
			}
			f.Close()
			lastFilePath = target
			fileCount++
		default:
			// symlinks, hardlinks, devices — preserve as best-effort by
			// counting them in otherCount so single-file detection stays
			// pessimistic (any non-regular entry forces "treat as dir").
			otherCount++
		}
	}

	isSingleFile = fileCount == 1 && otherCount == 0
	return lastFilePath, isSingleFile, nil
}

func BoxliteFileDownload(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		respondError(ctx, http.StatusInternalServerError, err.Error(), "InternalError", "internal")
		return
	}

	boxId := ctx.Param("boxId")
	srcPath := ctx.Query("path")
	if srcPath == "" {
		respondError(ctx, http.StatusBadRequest, "path query parameter required", "InvalidArgumentError", "invalid_argument")
		return
	}

	tmpDir, err := os.MkdirTemp("", "boxlite-download-*")
	if err != nil {
		respondError(ctx, http.StatusInternalServerError, "failed to create temp dir", "InternalError", "internal")
		return
	}
	defer os.RemoveAll(tmpDir)

	if err := r.Boxlite.CopyOut(ctx.Request.Context(), boxId, srcPath, tmpDir); err != nil {
		respondCopyError(ctx, err)
		return
	}

	ctx.Header("Content-Type", "application/x-tar")
	ctx.Status(http.StatusOK)

	tw := tar.NewWriter(ctx.Writer)
	defer tw.Close()

	filepath.Walk(tmpDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		relPath, _ := filepath.Rel(tmpDir, path)
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = relPath
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
}

// copyErrorClass is the (status, type, code) triple a BoxLite error crosses the
// wire as. Mirrors `BoxliteError::http()` in src/shared/src/errors.rs, which the
// client inverts in src/boxlite/src/rest/error.rs by dispatching on `code` —
// both sides have to name the same triple or a refusal arrives as something
// else.
type copyErrorClass struct {
	status    int
	errorType string
	code      string
}

var internalCopyErrorClass = copyErrorClass{http.StatusInternalServerError, "InternalError", "internal"}

// copyErrorClasses covers every code the Go SDK can return (sdks/go/errors.go),
// which is every runtime error variant — the FFI maps them one-for-one in
// sdks/c/src/error.rs. The whole table rather than the mount refusal alone: a
// copy also reports a missing source, an oversized upload and a stopped box,
// and every one of those was being reported as a server fault too.
var copyErrorClasses = map[boxlite.ErrorCode]copyErrorClass{
	boxlite.ErrInternal:          internalCopyErrorClass,
	boxlite.ErrNotFound:          {http.StatusNotFound, "NotFoundError", "not_found"},
	boxlite.ErrAlreadyExists:     {http.StatusConflict, "AlreadyExistsError", "already_exists"},
	boxlite.ErrInvalidState:      {http.StatusConflict, "InvalidStateError", "invalid_state"},
	boxlite.ErrInvalidArgument:   {http.StatusBadRequest, "InvalidArgumentError", "invalid_argument"},
	boxlite.ErrConfig:            {http.StatusInternalServerError, "ConfigError", "config_error"},
	boxlite.ErrStorage:           {http.StatusInternalServerError, "StorageError", "storage_error"},
	boxlite.ErrImage:             {http.StatusUnprocessableEntity, "ImageError", "image_pull_failed"},
	boxlite.ErrNetwork:           {http.StatusServiceUnavailable, "NetworkError", "network_unavailable"},
	boxlite.ErrExecution:         {http.StatusUnprocessableEntity, "ExecutionError", "execution_failed"},
	boxlite.ErrStopped:           {http.StatusConflict, "StoppedError", "stopped"},
	boxlite.ErrEngine:            {http.StatusServiceUnavailable, "EngineError", "engine_unavailable"},
	boxlite.ErrUnsupported:       {http.StatusBadRequest, "UnsupportedError", "unsupported"},
	boxlite.ErrDatabase:          {http.StatusInternalServerError, "DatabaseError", "database_error"},
	boxlite.ErrPortal:            {http.StatusServiceUnavailable, "UpstreamUnavailableError", "upstream_unavailable"},
	boxlite.ErrRpc:               {http.StatusServiceUnavailable, "UpstreamUnavailableError", "upstream_unavailable"},
	boxlite.ErrRpcTransport:      {http.StatusServiceUnavailable, "UpstreamUnavailableError", "upstream_unavailable"},
	boxlite.ErrMetadata:          {http.StatusInternalServerError, "MetadataError", "metadata_error"},
	boxlite.ErrUnsupportedEngine: {http.StatusBadRequest, "UnsupportedError", "unsupported"},
	boxlite.ErrResourceExhausted: {http.StatusTooManyRequests, "ResourceExhaustedError", "resource_exhausted"},
	boxlite.ErrSessionReaped:     {http.StatusGone, "SessionReapedError", "session_reaped"},
}

// respondCopyError answers a failed copy with the class the runtime gave it.
//
// A destination the guest refuses because a mount hides it is the caller's
// mistake, and openapi/box.openapi.yaml declares that refusal a `400` on both
// file routes. The class survives every hop up to here — the guest answers
// FailedPrecondition, and the FFI hands Go an *Error carrying ErrUnsupported —
// so calling every copy failure a 500 threw away an answer the runtime had
// already worked out, and left the client (src/boxlite/src/rest/error.rs) no
// envelope to read it from.
func respondCopyError(ctx *gin.Context, err error) {
	class, message := internalCopyErrorClass, err.Error()

	var runtimeErr *boxlite.Error
	if errors.As(err, &runtimeErr) {
		if known, ok := copyErrorClasses[runtimeErr.Code]; ok {
			class = known
		}
		// Message already holds the runtime's own rendering of the failure,
		// which is exactly what the local `boxlite serve` route emits for the
		// same refusal. `err.Error()` would wrap it in Go framing that route
		// never adds, leaving the two servers answering one refusal in two
		// different wordings.
		message = runtimeErr.Message
	}

	respondError(ctx, class.status, message, class.errorType, class.code)
}

// respondError writes the error envelope openapi/box.openapi.yaml declares for
// these routes: `{error: {message, type, code}}`.
//
// A bare `{"error": "<text>"}` names no class, so the client
// (src/boxlite/src/rest/error.rs) falls back to reading the status alone — and
// that fallback has no 400 arm, so every refusal these routes state plainly
// still reached the caller as a server fault.
func respondError(ctx *gin.Context, status int, message, errorType, code string) {
	ctx.JSON(status, gin.H{"error": gin.H{
		"message": message,
		"type":    errorType,
		"code":    code,
	}})
}
