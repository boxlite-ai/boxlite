// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// mainSessionIDHeader carries the main session's execution id back on the 101.
//
// A client attaching to a box cannot know that id up front, but it needs one
// for everything else an execution does — signal, resize, kill, status,
// reattach — all of which are addressed by execution id. Handing it back on
// the upgrade makes the main session an ordinary session from that point on,
// with no parallel control path. The client half of this contract is
// RestBox::attach in src/boxlite/src/rest/litebox.rs, which pins the same
// name and treats a missing header as a hard error.
const mainSessionIDHeader = "X-Boxlite-Execution-Id"

// errBoxNotFound marks a failed box lookup so the handler answers 404 rather
// than 500. Like POST /exec, it does not separate a missing box from a lookup
// that failed for another reason — the runner has no way to tell them apart
// here, and answering the two differently is not this change's to decide.
var errBoxNotFound = errors.New("box not found")

// openMainSession is the production opener; tests override it.
var openMainSession = func(ctx context.Context, boxId string) (attachExec, string, error) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		return nil, "", err
	}

	bx, err := r.Boxlite.GetBox(ctx, boxId)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %s: %w", errBoxNotFound, boxId, err)
	}

	me, err := execManager.AttachMain(ctx, bx, boxId)
	if err != nil {
		return nil, "", err
	}
	return managedExecAttach{me: me}, me.ID, nil
}

// BoxliteBoxAttach upgrades the request to a WebSocket on the box's main
// command session — the container's init.
//
// This is docker's `POST /containers/{id}/attach` as distinct from its
// exec-attach: `boxlite run IMAGE COMMAND` lands here because COMMAND *is*
// init, so there is no execution id in the path. The session is opened lazily
// on the first attach and then behaves exactly like an exec session, right
// down to running the same pump — runAttachLoop in boxlite_exec_attach.go.
//
//	@Summary	Attach to a box's main command session via WebSocket
//	@Tags		boxlite
//	@Param		boxId	path	string	true	"Box ID"
//	@Success	101
//	@Failure	404	{object}	map[string]string	"box not found"
//	@Failure	409	{object}	map[string]string	"already attached, or the box cannot be attached to"
//	@Router		/v1/boxes/{boxId}/attach [get]
func BoxliteBoxAttach(ctx *gin.Context) {
	boxId := ctx.Param("boxId")

	target, execId, err := openMainSession(ctx.Request.Context(), boxId)
	if err != nil {
		ctx.JSON(classifyAttachError(err), gin.H{
			"error": fmt.Sprintf("attach to box %s failed: %s", boxId, err),
		})
		return
	}

	if !target.MarkConnected() {
		// Refuse BEFORE upgrade so the client gets a real HTTP 409.
		ctx.JSON(http.StatusConflict, gin.H{
			"error": fmt.Sprintf("box %s main session already has an attached client", boxId),
		})
		return
	}

	conn, err := attachUpgrader.Upgrade(ctx.Writer, ctx.Request, http.Header{
		mainSessionIDHeader: []string{execId},
	})
	if err != nil {
		// Upgrade already wrote an error response on its own.
		target.MarkDisconnected()
		return
	}

	runAttachLoop(ctx.Request.Context(), conn, target)
}

// classifyAttachError maps an open failure onto a status. A box that exists
// but has already run to completion is a 409, not a 500: attaching to a
// stopped box is refused the same way docker refuses it, and the client can
// act on that.
func classifyAttachError(err error) int {
	switch {
	case errors.Is(err, errBoxNotFound):
		return http.StatusNotFound
	case sdkboxlite.IsStopped(err), sdkboxlite.IsInvalidState(err):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}
