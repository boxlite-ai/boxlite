package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Match Runtime's opaque Box IDs, including both Cloud IDs and local UUIDs.
var protectedBoxID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// ProtectedBootConfig is fixed by deployment for one enrolled HTTPS V0 Runner.
type ProtectedBootConfig struct {
	RunnerID   string
	DoHURL     string
	DoHAddress string
}

type protectedBootKey struct {
	RunnerID             string                   `json:"runner_id"`
	AttemptID            string                   `json:"attempt_id"`
	RegistrationID       *string                  `json:"registration_id"`
	RegistrationRevision *string                  `json:"registration_revision"`
	Policy               boxlite.OutboundSnapshot `json:"policy"`
}

type protectedBootRoute struct {
	Key                protectedBootKey `json:"key"`
	Scheme             *string          `json:"scheme,omitempty"`
	Host               *string          `json:"host,omitempty"`
	Port               *uint16          `json:"port,omitempty"`
	RecoveryGeneration string           `json:"recovery_generation,omitempty"`
	Restart            bool             `json:"restart,omitempty"`
	Credential         *struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"credential,omitempty"`
}

type protectedBootGate struct {
	Key        protectedBootKey `json:"key"`
	Epoch      string           `json:"epoch"`
	Generation string           `json:"generation"`
	Outbound   json.RawMessage  `json:"outbound,omitempty"`
}

type protectedOutboundControl struct {
	RunnerID string          `json:"runner_id"`
	Epoch    string          `json:"epoch"`
	Command  json.RawMessage `json:"command"`
}

type protectedBootRemoval struct {
	Key   protectedBootKey `json:"key"`
	Epoch json.RawMessage  `json:"epoch"`
}

func (c ProtectedBootConfig) validPin() bool {
	identity, idErr := uuid.Parse(c.RunnerID)
	resolver, urlErr := url.Parse(c.DoHURL)
	address, ipErr := netip.ParseAddrPort(c.DoHAddress)
	if idErr != nil || identity == uuid.Nil || identity.String() != c.RunnerID || urlErr != nil ||
		resolver.Scheme != "https" || resolver.Hostname() == "" || resolver.User != nil ||
		resolver.Fragment != "" || resolver.RawQuery != "" || resolver.ForceQuery || ipErr != nil ||
		!address.Addr().Is4() || !address.Addr().IsGlobalUnicast() || address.Addr().IsPrivate() {
		return false
	}
	if resolver.Port() == "" {
		return address.Port() == 443
	}
	port, err := strconv.ParseUint(resolver.Port(), 10, 16)
	return err == nil && port != 0 && uint16(port) == address.Port()
}

func registerProtectedBoot(group *gin.RouterGroup, c ProtectedBootConfig, version int, serveTLS bool) {
	if version != 0 || !serveTLS || !c.validPin() {
		return
	}
	protected := group.Group("/v1")
	protected.Use(func(ctx *gin.Context) {
		if ctx.Request.TLS == nil || ctx.GetHeader("X-BoxLite-Runner-Id") != c.RunnerID {
			ctx.AbortWithStatus(http.StatusForbidden)
			return
		}
		ctx.Next()
	})
	protected.GET("/outbound-proxy/bootstrap", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, gin.H{
			"runner_id": c.RunnerID, "version": 1,
			"operations": []string{"start", "receipt", "retire", "release-gate", "seal-gate", "managed-route", "unbound-start", "remove-retired"},
		})
	})
	path := "/boxes/:boxId/network/outbound/bootstrap"
	protected.POST(path, c.handleBoot(boxlite.ProtectedBootStart))
	protected.POST(path+"/receipt", c.handleBoot(boxlite.ProtectedBootRead))
	protected.POST(path+"/retire", c.handleBoot(boxlite.ProtectedBootRetire))
	protected.POST(path+"/release-gate", c.handleBoot(boxlite.ProtectedBootReleaseGate))
	protected.POST(path+"/seal-gate", c.handleBoot(boxlite.ProtectedBootSealGate))
	protected.POST(path+"/remove-retired", c.handleBoot(boxlite.ProtectedBootRemove))
	protected.POST("/boxes/:boxId/network/outbound/managed-route", c.handleBoot(boxlite.ProtectedOutboundControl))
}

func (c ProtectedBootConfig) handleBoot(operation boxlite.ProtectedBootOperation) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		boxID := ctx.Param("boxId")
		if !protectedBoxID.MatchString(boxID) {
			ctx.Status(http.StatusBadRequest)
			return
		}
		decode := json.NewDecoder(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 128<<10))
		decode.DisallowUnknownFields()
		var key protectedBootKey
		var payload any = &key
		switch operation {
		case boxlite.ProtectedBootStart:
			var route protectedBootRoute
			if decode.Decode(&route) != nil {
				ctx.Status(http.StatusBadRequest)
				return
			}
			if route.Key.Policy.Policy.AllowNet == nil {
				route.Key.Policy.Policy.AllowNet = []string{}
			}
			key = route.Key
			payload = struct {
				protectedBootRoute
				DoHURL     string `json:"doh_url"`
				DoHAddress string `json:"doh_address"`
			}{route, c.DoHURL, c.DoHAddress}
		case boxlite.ProtectedBootReleaseGate, boxlite.ProtectedBootSealGate:
			var gate protectedBootGate
			if decode.Decode(&gate) != nil || gate.Epoch == "" || gate.Generation == "" {
				ctx.Status(http.StatusBadRequest)
				return
			}
			if gate.Key.Policy.Policy.AllowNet == nil {
				gate.Key.Policy.Policy.AllowNet = []string{}
			}
			key = gate.Key
			payload = gate
		case boxlite.ProtectedOutboundControl:
			var control protectedOutboundControl
			if decode.Decode(&control) != nil || control.Epoch == "" || len(control.Command) == 0 {
				ctx.Status(http.StatusBadRequest)
				return
			}
			key.RunnerID = control.RunnerID
			payload = struct {
				protectedOutboundControl
				DoHURL     string `json:"doh_url"`
				DoHAddress string `json:"doh_address"`
			}{control, c.DoHURL, c.DoHAddress}
		case boxlite.ProtectedBootRemove:
			var removal protectedBootRemoval
			if decode.Decode(&removal) != nil || len(removal.Epoch) == 0 {
				ctx.Status(http.StatusBadRequest)
				return
			}
			if removal.Key.Policy.Policy.AllowNet == nil {
				removal.Key.Policy.Policy.AllowNet = []string{}
			}
			key = removal.Key
			payload = struct {
				protectedBootRemoval
				RunnerBoxName string `json:"runner_box_name"`
			}{removal, boxID}
		default:
			if decode.Decode(&key) != nil {
				ctx.Status(http.StatusBadRequest)
				return
			}
		}
		if key.Policy.Policy.AllowNet == nil {
			key.Policy.Policy.AllowNet = []string{}
		}
		if decode.Decode(new(any)) != io.EOF || key.RunnerID != c.RunnerID {
			ctx.Status(http.StatusBadRequest)
			return
		}
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.Status(http.StatusServiceUnavailable)
			return
		}
		result, err := r.Boxlite.ProtectedBoot(ctx.Request.Context(), boxID, operation, payload)
		if err != nil {
			switch {
			case boxlite.IsNotFound(err):
				ctx.Status(http.StatusNotFound)
			case boxlite.IsInvalidState(err):
				ctx.Status(http.StatusConflict)
			default:
				ctx.Status(http.StatusBadGateway)
			}
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"box_id": boxID, "receipt": result})
	}
}
