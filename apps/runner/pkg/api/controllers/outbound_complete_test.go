package controllers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	commonerrors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/gin-gonic/gin"
)

type completeOutboundStub struct {
	prepared sdk.PreparedOutboundCreate
	err      error
	policy   json.RawMessage
	revision string
	boxID    string
}

func (s *completeOutboundStub) PrepareOutboundCreate(_ context.Context, revision string, policy json.RawMessage) (sdk.PreparedOutboundCreate, error) {
	s.revision, s.policy = revision, policy
	return s.prepared, s.err
}

func (s *completeOutboundStub) CompleteOutboundSnapshot(_ context.Context, boxID string) (sdk.CompleteOutboundSnapshot, error) {
	s.boxID = boxID
	return s.prepared.Snapshot, s.err
}

func (s *completeOutboundStub) CompleteOutboundStatus(_ context.Context, boxID string) (sdk.CompleteOutboundStatus, error) {
	s.boxID = boxID
	return sdk.CompleteOutboundStatus{Persisted: s.prepared.Snapshot, ApplicationState: sdk.OutboundUncertain}, s.err
}

func TestCompleteOutboundRunnerHTTP(t *testing.T) {
	const path = "/v1/boxes/target/network/outbound/complete"
	const policy = `{"mode":"enabled","allow_net":["EXAMPLE.com:443"],"deny_net":[]}`
	control := &completeOutboundStub{prepared: sdk.PreparedOutboundCreate{
		DenyPresent: true,
		Snapshot: sdk.CompleteOutboundSnapshot{
			Revision:  "cloud-revision",
			Admission: sdk.OutboundAdmissionExtendedIPv4,
			Policy: sdk.EffectiveOutboundPolicy{
				Mode:     sdk.NetworkModeEnabled,
				AllowNet: []string{"example.com:443"},
				DenyNet:  []string{},
			},
		},
	}}
	h := NewCompleteOutboundHandlers(func() (CompleteOutboundControl, error) { return control, nil })
	router := gin.New()
	router.Use(commonerrors.NewErrorMiddleware(common.HandlePossibleDockerError), middlewares.AuthMiddleware("synthetic-control-key"))
	router.POST("/v1/boxes/:boxId/network/outbound/complete/prepare-create", h.PrepareCreate)
	router.GET("/v1/boxes/:boxId/network/outbound/complete", h.Snapshot)
	router.GET("/v1/boxes/:boxId/network/outbound/complete/status", h.Status)
	request := func(method, suffix, body, token string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		req := httptest.NewRequest(method, path+suffix, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("X-Boxlite-Outbound-Revision", "cloud-revision")
		router.ServeHTTP(response, req)
		return response
	}

	response := request(http.MethodPost, "/prepare-create", policy, "")
	if response.Code != http.StatusUnauthorized || control.revision != "" {
		t.Fatalf("unauthorized prepare: status=%d revision=%q", response.Code, control.revision)
	}
	response = request(http.MethodPost, "/prepare-create", policy+`{}`, "synthetic-control-key")
	if response.Code != http.StatusBadRequest || control.revision != "" {
		t.Fatalf("malformed prepare envelope: status=%d revision=%q", response.Code, control.revision)
	}
	response = request(http.MethodPost, "/prepare-create", policy, "synthetic-control-key")
	if response.Code != http.StatusOK || control.revision != "cloud-revision" || string(control.policy) != policy {
		t.Fatalf("prepare: status=%d revision=%q policy=%s", response.Code, control.revision, control.policy)
	}
	var prepared sdk.PreparedOutboundCreate
	if err := json.Unmarshal(response.Body.Bytes(), &prepared); err != nil || !prepared.DenyPresent || prepared.Snapshot.Policy.DenyNet == nil {
		t.Fatalf("prepared response: body=%s err=%v", response.Body, err)
	}

	response = request(http.MethodGet, "", "", "synthetic-control-key")
	if response.Code != http.StatusOK || response.Header().Get("ETag") != `"cloud-revision"` || control.boxID != "target" {
		t.Fatalf("snapshot: status=%d ETag=%s box=%q", response.Code, response.Header().Get("ETag"), control.boxID)
	}
	response = request(http.MethodGet, "/status", "", "synthetic-control-key")
	var status sdk.CompleteOutboundStatus
	if err := json.Unmarshal(response.Body.Bytes(), &status); response.Code != http.StatusOK || err != nil || status.ApplicationState != sdk.OutboundUncertain {
		t.Fatalf("status: code=%d body=%s err=%v", response.Code, response.Body, err)
	}

	control.err = &sdk.Error{Code: sdk.ErrUnsupported, Message: "backend refuses policy"}
	response = request(http.MethodPost, "/prepare-create", policy, "synthetic-control-key")
	if response.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported preparation: status=%d body=%s", response.Code, response.Body)
	}
}
