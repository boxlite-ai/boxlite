package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	runnerbox "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/containerd/errdefs"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	protectedDoHURL     = "https://cloudflare-dns.com/dns-query"
	protectedDoHAddress = "1.1.1.1:443"
)

type protectedBootKey struct {
	RunnerID             string               `json:"runner_id"`
	AttemptID            string               `json:"attempt_id"`
	RegistrationID       string               `json:"registration_id"`
	RegistrationRevision string               `json:"registration_revision"`
	Policy               sdk.OutboundSnapshot `json:"policy"`
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

func validProtectedBoxID(id string) bool {
	if len(id) == 12 {
		for _, ch := range id {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9') {
				return false
			}
		}
		return true
	}
	return uuid.Validate(id) == nil
}

func registerProtectedBoot(group *gin.RouterGroup, c ProtectedBootConfig, version int, serveTLS bool) {
	if version != 0 || !serveTLS || c.controlPlane == nil {
		return
	}
	protected := group.Group("/v1")
	protected.Use(func(ctx *gin.Context) {
		if ctx.Request.TLS == nil {
			ctx.AbortWithStatus(http.StatusForbidden)
			return
		}
		ctx.Next()
	})
	protected.GET("/outbound-proxy/bootstrap", func(ctx *gin.Context) {
		identity, err := c.call(ctx.Request.Context(), http.MethodGet, "identity", nil)
		if err != nil || ctx.GetHeader("X-BoxLite-Runner-Id") != identity.RunnerID {
			ctx.Status(http.StatusForbidden)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{
			"runner_id": identity.RunnerID, "version": 1,
			"operations": []string{"prepare", "start", "receipt", "retire"},
		})
	})
	path := "/boxes/:boxId/network/outbound/bootstrap"
	protected.POST(path+"/prepare", c.handlePreparation)
	protected.POST(path, c.handleBoot(sdk.ProtectedBootStart, "start"))
	protected.POST(path+"/receipt", c.handleBoot(sdk.ProtectedBootRead, "receipt"))
	protected.POST(path+"/retire", c.handleBoot(sdk.ProtectedBootRetire, "retire"))
}

func readProtectedPayload(ctx *gin.Context, payload any) ([]byte, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(payload); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("invalid protected request body")
	}
	return raw, nil
}

func (c ProtectedBootConfig) handlePreparation(ctx *gin.Context) {
	boxID := ctx.Param("boxId")
	var request struct {
		Key           protectedBootKey `json:"key"`
		Configuration dto.CreateBoxDTO `json:"configuration"`
	}
	raw, err := readProtectedPayload(ctx, &request)
	if err != nil || !validProtectedBoxID(boxID) || request.Configuration.Id != boxID {
		ctx.Status(http.StatusBadRequest)
		return
	}
	if request.Key.RunnerID == "" || request.Key.RunnerID != ctx.GetHeader("X-BoxLite-Runner-Id") {
		ctx.Status(http.StatusForbidden)
		return
	}
	fingerprint, err := requestFingerprint(raw, ctx.GetHeader("X-BoxLite-Bootstrap-Key"))
	if err != nil {
		ctx.Status(http.StatusForbidden)
		return
	}
	client, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Status(http.StatusServiceUnavailable)
		return
	}
	normalizeProtectedKey(&request.Key)
	nativeID, err := client.Boxlite.AllocateProtectedPlaceholder(ctx.Request.Context(), request.Configuration, runnerbox.ProtectedPreparation{
		AttemptID: request.Key.AttemptID, Fingerprint: fingerprint,
		Authorize: func(leaseContext context.Context) error {
			_, err := c.authorize(leaseContext, protectedGrantRequest{
				Operation: "prepare", BoxID: boxID, Key: request.Key, Fingerprint: fingerprint,
			})
			return err
		},
	})
	if err != nil {
		protectedBootError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"box_id": boxID, "native_id": nativeID})
}

func normalizeProtectedKey(key *protectedBootKey) {
	if key.Policy.Policy.AllowNet == nil {
		key.Policy.Policy.AllowNet = []string{}
	}
}

func (c ProtectedBootConfig) handleBoot(operation sdk.ProtectedBootOperation, name string) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		boxID := ctx.Param("boxId")
		if !validProtectedBoxID(boxID) {
			ctx.Status(http.StatusBadRequest)
			return
		}
		var key protectedBootKey
		var payload any = &key
		var fingerprint string
		if operation == sdk.ProtectedBootStart {
			var route protectedBootRoute
			raw, err := readProtectedPayload(ctx, &route)
			if err != nil {
				ctx.Status(http.StatusBadRequest)
				return
			}
			fingerprint, err = requestFingerprint(raw, ctx.GetHeader("X-BoxLite-Bootstrap-Key"))
			if err != nil {
				ctx.Status(http.StatusForbidden)
				return
			}
			normalizeProtectedKey(&route.Key)
			key = route.Key
			payload = struct {
				protectedBootRoute
				DoHURL     string `json:"doh_url"`
				DoHAddress string `json:"doh_address"`
			}{route, protectedDoHURL, protectedDoHAddress}
		} else if _, err := readProtectedPayload(ctx, &key); err != nil {
			ctx.Status(http.StatusBadRequest)
			return
		}
		if key.RunnerID == "" || key.RunnerID != ctx.GetHeader("X-BoxLite-Runner-Id") {
			ctx.Status(http.StatusForbidden)
			return
		}
		normalizeProtectedKey(&key)
		client, err := runner.GetInstance(nil)
		if err != nil {
			ctx.Status(http.StatusServiceUnavailable)
			return
		}
		result, err := client.Boxlite.AuthorizedProtectedBoot(
			ctx.Request.Context(), boxID, key.AttemptID, operation, payload,
			func(leaseContext context.Context, nativeID string) (runnerbox.ProtectedBootAdmission, error) {
				return c.authorize(leaseContext, protectedGrantRequest{
					Operation: name, BoxID: boxID, Key: key, Fingerprint: fingerprint, NativeID: nativeID,
				})
			},
		)
		if err != nil {
			protectedBootError(ctx, err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"box_id": boxID, "receipt": result})
	}
}

func protectedBootError(ctx *gin.Context, err error) {
	switch {
	case errors.Is(err, errProtectedAuthorization):
		ctx.Status(http.StatusForbidden)
	case sdk.IsNotFound(err):
		ctx.Status(http.StatusNotFound)
	case sdk.IsInvalidState(err) || errdefs.IsFailedPrecondition(err):
		ctx.Status(http.StatusConflict)
	default:
		ctx.Status(http.StatusBadGateway)
	}
}
