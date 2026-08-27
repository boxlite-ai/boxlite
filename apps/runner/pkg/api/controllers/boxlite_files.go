package controllers

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

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

	// Newer clients carry the archive shape; older clients omit it. Either way
	// we stream straight into the guest — hint=Unknown makes the guest peek
	// the archive to decide (its pre-hint behavior). No runner-side staging.
	kind := parseSourceIsDir(ctx.Query("source_is_dir"))
	if err := r.Boxlite.CopyInStream(ctx.Request.Context(), boxId, destPath, kind, ctx.Request.Body); err != nil {
		respondCopyError(ctx, err)
		return
	}

	ctx.Status(http.StatusNoContent)
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

	ctx.Header("Content-Type", "application/x-tar")

	// Stream straight from the guest into the response. onMeta sets the
	// archive-shape header before the first body byte; it is not invoked when
	// the guest predates the hint.
	err = r.Boxlite.CopyOutStream(ctx.Request.Context(), boxId, srcPath, ctx.Writer, func(sourceIsDir bool) {
		ctx.Header("X-Boxlite-Source-Is-Dir", strconv.FormatBool(sourceIsDir))
	})
	if err == nil {
		return
	}
	if !ctx.Writer.Written() {
		// The copy failed before any body byte was produced (e.g. the source
		// does not exist) — the response is not yet committed, so we can still
		// surface an error status.
		respondCopyError(ctx, err)
		return
	}
	// A 200 is already on the wire and the archive is incomplete. Returning
	// normally would finish the body cleanly, which the client cannot tell
	// apart from a whole archive — a tar cut on a 512-byte block boundary
	// extracts without error, just missing entries. Severing the connection is
	// the only remaining way to say "this is not the whole thing".
	slog.Error("boxlite copy_out failed mid-stream, aborting the response",
		"boxId", boxId, "path", srcPath, "error", err)
	panic(http.ErrAbortHandler)
}

// parseSourceIsDir maps the optional source_is_dir query parameter to a
// copy-source kind. Absent or malformed values mean the client predates the
// hint → Unknown, which makes the guest peek the archive to decide.
func parseSourceIsDir(raw string) boxlite.CopySourceKind {
	if raw == "" {
		return boxlite.CopySourceUnknown
	}
	b, err := strconv.ParseBool(raw)
	if err != nil {
		return boxlite.CopySourceUnknown
	}
	if b {
		return boxlite.CopySourceDir
	}
	return boxlite.CopySourceFile
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
