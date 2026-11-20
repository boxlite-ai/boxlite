package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/containerd/errdefs"
	"github.com/gin-gonic/gin"
)

type CompleteOutboundControl interface {
	PrepareOutboundCreate(context.Context, string, json.RawMessage) (sdk.PreparedOutboundCreate, error)
	CompleteOutboundSnapshot(context.Context, string) (sdk.CompleteOutboundSnapshot, error)
	CompleteOutboundStatus(context.Context, string) (sdk.CompleteOutboundStatus, error)
}

type CompleteOutboundCreateControl interface {
	CreateCompleteOutbound(context.Context, string, dto.CompleteCreateRequest) (dto.CompleteCreateResult, error)
	CancelCompleteOutboundCreate(context.Context, string, dto.CompleteCreateAttempt) (dto.CompleteCreateResult, error)
}

type HostedOutboundControl interface {
	HostedOutbound(context.Context, string, json.RawMessage) (sdk.HostedOutboundReceipt, error)
}

type CompleteOutboundRebuildControl interface {
	RebuildCompleteOutbound(context.Context, string, dto.CompleteRebuildRequest) (sdk.CompleteOutboundSnapshot, error)
}

type CompleteOutboundHandlers struct {
	client func() (CompleteOutboundControl, error)
}

// NewCompleteOutboundHandlers uses the running BoxLite client when lookup is nil.
func NewCompleteOutboundHandlers(lookup func() (CompleteOutboundControl, error)) CompleteOutboundHandlers {
	if lookup == nil {
		lookup = runnerCompleteOutboundControl
	}
	return CompleteOutboundHandlers{client: lookup}
}

func runnerCompleteOutboundControl() (CompleteOutboundControl, error) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		return nil, err
	}
	if r.Boxlite == nil {
		return nil, &sdk.Error{Code: sdk.ErrUnsupported, Message: "runner does not support complete outbound control"}
	}
	return r.Boxlite, nil
}

func (h CompleteOutboundHandlers) PrepareCreate(ctx *gin.Context) {
	const maxPolicyBytes = 64 << 10
	revisions := ctx.Request.Header.Values("X-Boxlite-Outbound-Revision")
	if len(revisions) != 1 || !sdk.ValidOutboundRevision(revisions[0]) || revisions[0] == "initial" {
		respondError(ctx, http.StatusBadRequest, "one allocated outbound revision is required", "InvalidArgumentError", "invalid_argument")
		return
	}
	policy, err := io.ReadAll(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, maxPolicyBytes))
	if err != nil || !json.Valid(policy) {
		respondError(ctx, http.StatusBadRequest, "invalid outbound preparation request", "InvalidArgumentError", "invalid_argument")
		return
	}
	client, err := h.client()
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	prepared, err := client.PrepareOutboundCreate(ctx.Request.Context(), revisions[0], policy)
	if err != nil {
		var sdkErr *sdk.Error
		if errors.As(err, &sdkErr) && sdkErr.Code == sdk.ErrUnsupported {
			respondError(ctx, http.StatusNotImplemented, "backend lacks required outbound capabilities", "UnsupportedError", "unsupported")
			return
		}
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, prepared)
}

func (h CompleteOutboundHandlers) Snapshot(ctx *gin.Context) {
	client, err := h.client()
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	snapshot, err := client.CompleteOutboundSnapshot(ctx.Request.Context(), ctx.Param("boxId"))
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.Header("ETag", `"`+snapshot.Revision+`"`)
	ctx.JSON(http.StatusOK, snapshot)
}

func (h CompleteOutboundHandlers) Status(ctx *gin.Context) {
	client, err := h.client()
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	status, err := client.CompleteOutboundStatus(ctx.Request.Context(), ctx.Param("boxId"))
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, status)
}

func (h CompleteOutboundHandlers) ReplaceControl(ctx *gin.Context) {
	var command json.RawMessage
	if !bindCompleteCreate(ctx, &command) {
		return
	}
	client, err := h.client()
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	control, ok := client.(HostedOutboundControl)
	if !ok {
		respondError(ctx, http.StatusNotImplemented, "Runner lacks hosted outbound control", "UnsupportedError", "unsupported")
		return
	}
	receipt, err := control.HostedOutbound(ctx.Request.Context(), ctx.Param("boxId"), command)
	if err != nil {
		var failure *sdk.Error
		if errors.As(err, &failure) && failure.Code == sdk.ErrUnsupported {
			respondError(ctx, http.StatusNotImplemented, "backend lacks required outbound capabilities", "UnsupportedError", "unsupported")
			return
		}
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, receipt)
}

func (h CompleteOutboundHandlers) Rebuild(ctx *gin.Context) {
	var request dto.CompleteRebuildRequest
	if !bindCompleteCreate(ctx, &request) {
		return
	}
	client, err := h.client()
	if err != nil {
		respondCompleteCreate(ctx, dto.CompleteCreateResult{}, err)
		return
	}
	rebuild, ok := client.(CompleteOutboundRebuildControl)
	if !ok {
		respondError(ctx, http.StatusNotImplemented, "Runner lacks complete outbound rebuild", "UnsupportedError", "unsupported")
		return
	}
	snapshot, err := rebuild.RebuildCompleteOutbound(ctx.Request.Context(), ctx.Param("boxId"), request)
	if err != nil {
		var failure *sdk.Error
		if errors.As(err, &failure) && failure.Code == sdk.ErrInvalidState {
			respondCopyError(ctx, err)
			return
		}
		respondCompleteCreate(ctx, dto.CompleteCreateResult{}, err)
		return
	}
	ctx.JSON(http.StatusOK, snapshot)
}

func (h CompleteOutboundHandlers) Create(ctx *gin.Context) {
	var request dto.CompleteCreateRequest
	if !bindCompleteCreate(ctx, &request) {
		return
	}
	if request.Attempt.JobID != "" || request.Attempt.ClaimID != "" {
		respondError(ctx, http.StatusBadRequest, "V2 claims require the Runner queue", "InvalidArgumentError", "invalid_argument")
		return
	}
	client, ok := h.createClient(ctx)
	if !ok {
		return
	}
	result, err := client.CreateCompleteOutbound(ctx.Request.Context(), ctx.Param("boxId"), request)
	respondCompleteCreate(ctx, result, err)
}

func (h CompleteOutboundHandlers) CancelCreate(ctx *gin.Context) {
	var attempt dto.CompleteCreateAttempt
	if !bindCompleteCreate(ctx, &attempt) {
		return
	}
	client, ok := h.createClient(ctx)
	if !ok {
		return
	}
	result, err := client.CancelCompleteOutboundCreate(ctx.Request.Context(), ctx.Param("boxId"), attempt)
	respondCompleteCreate(ctx, result, err)
}

func bindCompleteCreate(ctx *gin.Context, request any) bool {
	const maxCompleteCreateBytes = 1 << 20
	decoder := json.NewDecoder(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, maxCompleteCreateBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(request); err != nil || decoder.Decode(new(any)) != io.EOF {
		respondError(ctx, http.StatusBadRequest, "invalid complete create request", "InvalidArgumentError", "invalid_argument")
		return false
	}
	return true
}

func (h CompleteOutboundHandlers) createClient(ctx *gin.Context) (CompleteOutboundCreateControl, bool) {
	client, err := h.client()
	if err != nil {
		respondCompleteCreate(ctx, dto.CompleteCreateResult{}, err)
		return nil, false
	}
	create, ok := client.(CompleteOutboundCreateControl)
	if !ok {
		respondError(ctx, http.StatusNotImplemented, "runner does not support complete create", "UnsupportedError", "unsupported")
	}
	return create, ok
}

func respondCompleteCreate(ctx *gin.Context, result dto.CompleteCreateResult, err error) {
	var sdkErr *sdk.Error
	switch {
	case err == nil:
		ctx.JSON(http.StatusOK, result)
	case errors.Is(err, checkpoint.ErrCompleteCreateConflict):
		respondError(ctx, http.StatusConflict, "target is owned by another Box operation", "InvalidStateError", "invalid_state")
	case errors.As(err, &sdkErr) && sdkErr.Code == sdk.ErrUnsupported:
		respondError(ctx, http.StatusNotImplemented, "backend lacks required complete create capabilities", "UnsupportedError", "unsupported")
	case errors.As(err, &sdkErr) && sdkErr.Code == sdk.ErrInvalidArgument:
		respondError(ctx, http.StatusBadRequest, sdkErr.Message, "InvalidArgumentError", "invalid_argument")
	case errdefs.IsInvalidArgument(err):
		respondError(ctx, http.StatusBadRequest, "invalid complete create configuration", "InvalidArgumentError", "invalid_argument")
	default:
		respondError(ctx, http.StatusServiceUnavailable, "runner could not settle complete create", "ServiceUnavailableError", "unavailable")
	}
}
