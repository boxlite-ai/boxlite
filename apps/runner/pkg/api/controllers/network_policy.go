package controllers

import (
	"encoding/json"
	"io"
	"net/http"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// BoxliteSetOutboundNetwork handles a complete replacement, never a patch.
func BoxliteSetOutboundNetwork(ctx *gin.Context) {
	var policy dto.OutboundNetworkPolicy
	decoder := json.NewDecoder(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		respondError(ctx, 400, "invalid outbound policy", "InvalidArgumentError", "invalid_argument")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		respondError(ctx, 400, "expected one outbound policy", "InvalidArgumentError", "invalid_argument")
		return
	}
	if err := policy.Validate(); err != nil {
		respondError(ctx, http.StatusBadRequest, err.Error(), "InvalidArgumentError", "invalid_argument")
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil {
		respondError(ctx, 500, "runner unavailable", "InternalError", "internal_error")
		return
	}
	if err := r.Boxlite.SetOutboundNetwork(ctx.Request.Context(), ctx.Param("boxId"), boxlite.OutboundNetworkSpec{
		Mode: policy.Mode, AllowNet: policy.AllowNet,
	}); err != nil {
		respondCopyError(ctx, err)
		return
	}
	if policy.AllowNet == nil {
		policy.AllowNet = []string{}
	}
	ctx.JSON(http.StatusOK, policy)
}
