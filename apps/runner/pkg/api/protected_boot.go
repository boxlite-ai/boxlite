package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// ProtectedBootConfig is fixed by deployment for one enrolled HTTPS V0 Runner.
type ProtectedBootConfig struct {
	RunnerID   string
	DoHURL     string
	DoHAddress string
}

type protectedBootKey struct {
	RunnerID             string                   `json:"runner_id"`
	AttemptID            string                   `json:"attempt_id"`
	RegistrationID       string                   `json:"registration_id"`
	RegistrationRevision string                   `json:"registration_revision"`
	Policy               boxlite.OutboundSnapshot `json:"policy"`
}

type protectedBootRoute struct {
	Key        protectedBootKey `json:"key"`
	Scheme     string           `json:"scheme"`
	Host       string           `json:"host"`
	Port       uint16           `json:"port"`
	Credential *struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"credential,omitempty"`
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
			"operations": []string{"start", "receipt", "retire"},
		})
	})
	path := "/boxes/:boxId/network/outbound/bootstrap"
	protected.POST(path, c.handleBoot(boxlite.ProtectedBootStart))
	protected.POST(path+"/receipt", c.handleBoot(boxlite.ProtectedBootRead))
	protected.POST(path+"/retire", c.handleBoot(boxlite.ProtectedBootRetire))
}

func (c ProtectedBootConfig) handleBoot(operation boxlite.ProtectedBootOperation) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		boxID := ctx.Param("boxId")
		if err := uuid.Validate(boxID); err != nil {
			ctx.Status(http.StatusBadRequest)
			return
		}
		decode := json.NewDecoder(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 64<<10))
		decode.DisallowUnknownFields()
		var key protectedBootKey
		var payload any = &key
		if operation == boxlite.ProtectedBootStart {
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
		} else if decode.Decode(&key) != nil {
			ctx.Status(http.StatusBadRequest)
			return
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
