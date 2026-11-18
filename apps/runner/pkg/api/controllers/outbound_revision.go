package controllers

import (
	"context"
	"net/http"
	"strings"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

type outboundControl interface {
	OutboundSnapshot(context.Context, string) (sdk.OutboundSnapshot, error)
	OutboundStatus(context.Context, string) (sdk.OutboundStatus, error)
	ReplaceOutboundSnapshot(context.Context, string, string, sdk.OutboundSnapshot) (sdk.OutboundReplaceOutcome, error)
}

type outboundRevisionHandlers struct {
	client func() (outboundControl, error)
}

func runnerOutboundControl() (outboundControl, error) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		return nil, err
	}
	if r.Boxlite == nil {
		return nil, &sdk.Error{Code: sdk.ErrUnsupported, Message: "runner does not support revisioned outbound control"}
	}
	return r.Boxlite, nil
}

func BoxliteGetOutboundNetwork(ctx *gin.Context) {
	(outboundRevisionHandlers{runnerOutboundControl}).snapshot(ctx)
}
func BoxliteOutboundStatus(ctx *gin.Context) {
	(outboundRevisionHandlers{runnerOutboundControl}).status(ctx)
}
func BoxliteReplaceOutboundSnapshot(ctx *gin.Context) {
	(outboundRevisionHandlers{runnerOutboundControl}).replace(ctx)
}

func (h outboundRevisionHandlers) snapshot(ctx *gin.Context) {
	client, err := h.client()
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	snapshot, err := client.OutboundSnapshot(ctx.Request.Context(), ctx.Param("boxId"))
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.Header("ETag", `"`+snapshot.Revision+`"`)
	ctx.JSON(http.StatusOK, snapshot.Policy)
}

func (h outboundRevisionHandlers) status(ctx *gin.Context) {
	client, err := h.client()
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	status, err := client.OutboundStatus(ctx.Request.Context(), ctx.Param("boxId"))
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, struct {
		sdk.OutboundStatus
		Capabilities []string `json:"capabilities"`
	}{status, []string{"revision-v1"}})
}

func outboundHeaders(header http.Header) (string, string, bool) {
	expected, candidate := header.Values("If-Match"), header.Values("X-Boxlite-Outbound-Revision")
	if len(expected) != 1 || len(candidate) != 1 {
		return "", "", false
	}
	tag := strings.Trim(expected[0], " \t")
	if len(tag) < 2 || tag[0] != '"' || tag[len(tag)-1] != '"' {
		return "", "", false
	}
	current, next := tag[1:len(tag)-1], candidate[0]
	return current, next, sdk.ValidOutboundRevision(current) && sdk.ValidOutboundRevision(next) && next != current && next != "initial"
}

func (h outboundRevisionHandlers) replace(ctx *gin.Context) {
	expected, candidate, valid := outboundHeaders(ctx.Request.Header)
	if !valid {
		respondError(ctx, http.StatusBadRequest, "one strong expected revision and a fresh candidate are required", "InvalidArgumentError", "invalid_argument")
		return
	}
	policy, valid := readOutboundPolicy(ctx)
	if !valid {
		return
	}
	if policy.AllowNet == nil {
		policy.AllowNet = []string{}
	}
	client, err := h.client()
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	outcome, err := client.ReplaceOutboundSnapshot(ctx.Request.Context(), ctx.Param("boxId"), expected, sdk.OutboundSnapshot{
		Revision: candidate, Policy: sdk.OutboundPolicy{Mode: policy.Mode, AllowNet: policy.AllowNet},
	})
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	if outcome == sdk.OutboundPreconditionFailed {
		ctx.Status(http.StatusPreconditionFailed)
		return
	}
	if outcome != sdk.OutboundApplied {
		respondCopyError(ctx, &sdk.Error{Code: sdk.ErrNetwork, Message: "outbound application was not confirmed"})
		return
	}
	ctx.Header("ETag", `"`+candidate+`"`)
	ctx.JSON(http.StatusOK, policy)
}
