package controllers

import (
	"fmt"
	"net/http"
	"time"

	boxlitesdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// SshAccessEntryRequest is one box-scoped temporary SSH credential in the
// desired full-set access snapshot.
type SshAccessEntryRequest struct {
	ID          string    `json:"id" binding:"required"`
	GrantID     string    `json:"grantId" binding:"required"`
	PublicKey   string    `json:"publicKey" binding:"required"`
	Fingerprint string    `json:"fingerprint"`
	UnixUser    string    `json:"unixUser" binding:"required"`
	ExpiresAt   time.Time `json:"expiresAt" binding:"required"`
}

// SshAccessSetRequest is a full-set replace request: `generation` must be
// strictly newer than the guest's currently applied generation, or
// identical with byte-identical `accesses` (idempotent retry).
type SshAccessSetRequest struct {
	Generation uint64                  `json:"generation"`
	Accesses   []SshAccessEntryRequest `json:"accesses"`
}

// SshAccessSetResponse mirrors the design's Runner internal API response
// shape (section 6.3): applied generation, listener readiness, and host
// identity, as last observed from the guest.
type SshAccessSetResponse struct {
	AppliedGeneration  uint64 `json:"appliedGeneration"`
	ListenerReady      bool   `json:"listenerReady"`
	HostPublicKey      string `json:"hostPublicKey"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
}

// BoxliteSshAccessSet applies a full-set replace of a box's SSH access
// snapshot via the typed BoxLite Runtime facade. SSH bytes themselves never
// touch this endpoint -- they stay on the existing
// `CONNECT /v1/boxes/:boxId/network/tunnel` data path.
func BoxliteSshAccessSet(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	boxId := ctx.Param("boxId")

	var req SshAccessSetRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request: %s", err)})
		return
	}

	accesses := make([]boxlitesdk.SshAccessEntry, len(req.Accesses))
	for i, a := range req.Accesses {
		accesses[i] = boxlitesdk.SshAccessEntry{
			CredentialID: a.ID,
			GrantID:      a.GrantID,
			PublicKey:    a.PublicKey,
			Fingerprint:  a.Fingerprint,
			UnixUser:     a.UnixUser,
			ExpiresAt:    a.ExpiresAt,
		}
	}

	status, err := r.Boxlite.ReplaceSshAccessSet(ctx.Request.Context(), boxId, req.Generation, accesses)
	if err != nil {
		switch {
		case boxlitesdk.IsNotFound(err):
			ctx.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("box not found: %s", err)})
		case boxlitesdk.IsInvalidArgument(err):
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case boxlitesdk.IsResourceExhausted(err):
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": err.Error()})
		case boxlitesdk.IsInvalidState(err):
			// Stale/conflicting generation, or the box isn't running --
			// retryable once the caller re-syncs generation/state.
			ctx.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			// Typed unavailable per the design's error contract: guest
			// listener down/unreachable must map to a retryable 503, not
			// silently claim the access set applied.
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
		}
		return
	}

	ctx.JSON(http.StatusOK, SshAccessSetResponse{
		AppliedGeneration:  status.AppliedGeneration,
		ListenerReady:      status.ListenerReady,
		HostPublicKey:      status.HostPublicKey,
		HostKeyFingerprint: status.HostFingerprint,
	})
}
