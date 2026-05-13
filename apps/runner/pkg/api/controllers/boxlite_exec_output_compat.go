// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/boxlite-ai/runner/internal"
	"github.com/gin-gonic/gin"
)

// BoxliteExecOutputCompat handles GET /v1/boxes/:boxId/executions/:execId/output,
// which was the SSE streaming endpoint used by boxlite SDK < 0.9.4.
//
// That endpoint no longer exists — exec output is now streamed over the
// WebSocket /attach endpoint. Rather than returning a bare 404 (which causes
// the old SDK to silently drop the result channel and surface an opaque
// "Result channel closed" error), we respond with HTTP 200 and emit a single
// SSE exit event carrying an actionable upgrade message so the caller can
// surface it through the normal ExecResult.error_message path.
//
// Wire format: the old SDK's dispatch_sse_event parsed the "error" key
// (parsed.get("error")) to populate ExecResult.error_message, so the field
// name must remain "error" even though the Python dataclass field is
// error_message. Confirmed by the SSE→WebSocket migration commit (236b76d).
//
// If the execution was already started (the old SDK always called /exec first),
// we kill and evict it before responding. This prevents a split-brain outcome
// where the caller receives an immediate failure while the real process continues
// mutating state in the sandbox.
func BoxliteExecOutputCompat(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	execId := ctx.Param("execId")

	// Kill and evict the execution before telling the old SDK it is done.
	// The old SDK flow is: POST /exec → GET /output (this handler). If the
	// exec was started, leaving it running after we return a fake exit event
	// would produce a split-brain: the caller sees failure, the process
	// continues changing sandbox state. Ignore "not found" — /output may
	// arrive before /exec in pathological ordering, or after the execution
	// already completed naturally.
	//
	// On Kill failure we must not emit the terminal SSE event: ExecManager.Kill
	// only evicts the exec after a confirmed kill, so a Kill error means the
	// process is still running. Emitting a success event in that case is the
	// same split-brain we are trying to prevent. Return 503 so the caller
	// surfaces a real error rather than silently accepting a bad state.
	if _, err := execManager.GetForBox(execId, boxId); err == nil {
		if killErr := execManager.Kill(execId); killErr != nil {
			slog.Error("boxlite: compat /output handler: kill failed, refusing to emit terminal event",
				"exec_id", execId, "box_id", boxId, "err", killErr)
			ctx.String(http.StatusServiceUnavailable,
				"compat cleanup failed: could not kill execution %s: %v", execId, killErr)
			return
		}
	}

	ctx.Header("Content-Type", "text/event-stream")
	ctx.Header("Cache-Control", "no-cache")
	ctx.Header("X-Accel-Buffering", "no")

	msg := fmt.Sprintf(
		"boxlite SDK out of date — exec output is now streamed via WebSocket /attach. "+
			"Upgrade: pip install \"boxlite>=%s\"",
		internal.Version,
	)

	// Use encoding/json.Marshal so control characters are encoded as \uXXXX,
	// not as Go's %q escape sequences (\a, \v) which JSON parsers reject.
	encodedMsg, err := json.Marshal(msg)
	if err != nil {
		// msg is a pure ASCII format string — Marshal cannot fail here;
		// guard against future changes that introduce non-encodable values.
		ctx.String(http.StatusInternalServerError, "event: exit\ndata: {\"exit_code\":-1}\n\n")
		return
	}
	payload := fmt.Sprintf(`{"exit_code":-1,"error":%s}`, encodedMsg)

	ctx.String(http.StatusOK,
		"event: exit\ndata: %s\n\n",
		payload,
	)
}
