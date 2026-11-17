package controllers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/gin-gonic/gin"
)

type outboundControlStub struct {
	current         sdk.OutboundSnapshot
	observed        sdk.OutboundStatus
	outcome         sdk.OutboundReplaceOutcome
	err             error
	calls           int
	expected, boxID string
	candidate       sdk.OutboundSnapshot
}

func (s *outboundControlStub) OutboundSnapshot(context.Context, string) (sdk.OutboundSnapshot, error) {
	return s.current, s.err
}
func (s *outboundControlStub) OutboundStatus(context.Context, string) (sdk.OutboundStatus, error) {
	return s.observed, s.err
}
func (s *outboundControlStub) ReplaceOutboundSnapshot(_ context.Context, boxID, expected string, candidate sdk.OutboundSnapshot) (sdk.OutboundReplaceOutcome, error) {
	s.calls++
	s.boxID, s.expected, s.candidate = boxID, expected, candidate
	return s.outcome, s.err
}

func outboundRouter(client func() (outboundControl, error), middleware ...gin.HandlerFunc) *gin.Engine {
	h := outboundRevisionHandlers{client}
	router := gin.New()
	router.Use(middleware...)
	router.GET("/boxes/:boxId/network/outbound", h.snapshot)
	router.GET("/boxes/:boxId/network/outbound/status", h.status)
	router.PUT("/boxes/:boxId/network/outbound/snapshot", h.replace)
	return router
}

func outboundRequest(router *gin.Engine, body string, headers http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, "/boxes/box1/network/outbound/snapshot", strings.NewReader(body))
	request.Header = headers
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func TestOutboundRevisionHTTPPreservesBodyAndCandidateAcknowledgement(t *testing.T) {
	control := &outboundControlStub{outcome: sdk.OutboundApplied}
	router := outboundRouter(func() (outboundControl, error) { return control, nil })
	response := outboundRequest(router, `{"mode":"disabled"}`, http.Header{"If-Match": {`"rev-a"`}, "X-Boxlite-Outbound-Revision": {"rev-b"}})
	if response.Code != 200 || response.Header().Get("ETag") != `"rev-b"` || !jsonEqual(t, response.Body.String(), `{"mode":"disabled","allow_net":[]}`) {
		t.Fatalf("response: %d %v %s", response.Code, response.Header(), response.Body)
	}
	if control.calls != 1 || control.boxID != "box1" || control.expected != "rev-a" || control.candidate.Revision != "rev-b" || control.candidate.Policy.Mode != sdk.NetworkModeDisabled || control.candidate.Policy.AllowNet == nil {
		t.Fatalf("wrong forwarded operation: %+v", control)
	}
	for _, tc := range []struct {
		outcome sdk.OutboundReplaceOutcome
		err     error
		status  int
	}{
		{outcome: sdk.OutboundPreconditionFailed, status: 412},
		{err: &sdk.Error{Code: sdk.ErrNetwork, Message: "uncertain"}, status: 503},
		{err: &sdk.Error{Code: sdk.ErrUnsupported, Message: "old backend"}, status: 400},
		{status: 503},
	} {
		control.outcome, control.err = tc.outcome, tc.err
		response = outboundRequest(router, `{"mode":"enabled"}`, http.Header{"If-Match": {`"rev-a"`}, "X-Boxlite-Outbound-Revision": {"rev-c"}})
		if response.Code != tc.status || response.Header().Get("ETag") != "" {
			t.Fatalf("unconfirmed response: %d %v %s", response.Code, response.Header(), response.Body)
		}
	}
}

func TestOutboundRevisionHTTPRejectsMalformedMetadataBeforeClientLookup(t *testing.T) {
	lookups := 0
	router := outboundRouter(func() (outboundControl, error) { lookups++; return &outboundControlStub{}, nil })
	for _, header := range []http.Header{
		{}, {"If-Match": {`"rev-a"`}}, {"X-Boxlite-Outbound-Revision": {"rev-b"}},
		{"If-Match": {`W/"rev-a"`}, "X-Boxlite-Outbound-Revision": {"rev-b"}},
		{"If-Match": {`"rev-a", "other"`}, "X-Boxlite-Outbound-Revision": {"rev-b"}},
		{"If-Match": {`"rev-a"`, `"other"`}, "X-Boxlite-Outbound-Revision": {"rev-b"}},
		{"If-Match": {`*`}, "X-Boxlite-Outbound-Revision": {"rev-b"}},
		{"If-Match": {`"bad value"`}, "X-Boxlite-Outbound-Revision": {"rev-b"}},
		{"If-Match": {`"rev-a"`}, "X-Boxlite-Outbound-Revision": {"initial"}},
		{"If-Match": {`"rev-a"`}, "X-Boxlite-Outbound-Revision": {"rev-a"}},
		{"If-Match": {`"rev-a"`}, "X-Boxlite-Outbound-Revision": {"rev-b", "rev-c"}},
	} {
		response := outboundRequest(router, `{"mode":"enabled"}`, header)
		if response.Code != 400 {
			t.Fatalf("accepted %v: %d %s", header, response.Code, response.Body)
		}
	}
	for _, body := range []string{`{}`, `{"mode":"public"}`, `{"mode":"disabled","allow_net":["example.com"]}`, `{"mode":"enabled","revision":"rev-b"}`, `{"mode":"enabled"}{}`, strings.Repeat(" ", 64<<10) + `{"mode":"enabled"}`} {
		response := outboundRequest(router, body, http.Header{"If-Match": {`"rev-a"`}, "X-Boxlite-Outbound-Revision": {"rev-b"}})
		if response.Code != 400 {
			t.Fatalf("accepted body: %d %s", response.Code, response.Body)
		}
	}
	if lookups != 0 {
		t.Fatalf("invalid request reached client lookup %d times", lookups)
	}
}

func TestOutboundRevisionHTTPSeparatesPolicyAndReadbackMetadata(t *testing.T) {
	current := sdk.OutboundSnapshot{Policy: sdk.OutboundPolicy{Mode: sdk.NetworkModeEnabled, AllowNet: []string{}}, Revision: "rev-a"}
	control := &outboundControlStub{current: current, observed: sdk.OutboundStatus{
		Persisted: current, ApplicationState: sdk.OutboundUncertain, PendingRevision: "rev-b",
		Observed: &sdk.OutboundSnapshotStatus{OutboundSnapshot: current, ApplicationState: sdk.OutboundConfirmed},
	}}
	router := outboundRouter(func() (outboundControl, error) { return control, nil })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/boxes/box1/network/outbound", nil))
	if response.Code != 200 || response.Header().Get("ETag") != `"rev-a"` || !jsonEqual(t, response.Body.String(), `{"mode":"enabled","allow_net":[]}`) {
		t.Fatalf("policy: %d %s", response.Code, response.Body)
	}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/boxes/box1/network/outbound/status", nil))
	var value map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || value["application_state"] != "uncertain" || value["pending_revision"] != "rev-b" || value["capabilities"].([]any)[0] != "revision-v1" {
		t.Fatalf("status: %d %s", response.Code, response.Body)
	}
	if control.calls != 0 {
		t.Fatal("GET mutated outbound policy")
	}
}

func TestOutboundRevisionLegacyResourceRejectsCoordinatorHeaders(t *testing.T) {
	router := gin.New()
	router.PUT("/boxes/:boxId/network/outbound", BoxliteSetOutboundNetwork)
	for _, name := range []string{"If-Match", "X-Boxlite-Outbound-Revision"} {
		request := httptest.NewRequest(http.MethodPut, "/boxes/box1/network/outbound", strings.NewReader(`{"mode":"enabled"}`))
		request.Header.Set(name, "rev-a")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != 400 || !strings.Contains(response.Body.String(), `"code":"unsupported"`) {
			t.Fatalf("legacy accepted metadata: %d %s", response.Code, response.Body)
		}
	}
}

func TestOutboundRevisionHTTPUsesExistingBearerBoundary(t *testing.T) {
	var lookups atomic.Int32
	current := sdk.OutboundSnapshot{Revision: "rev-a", Policy: sdk.OutboundPolicy{Mode: sdk.NetworkModeEnabled, AllowNet: []string{}}}
	control := &outboundControlStub{current: current, outcome: sdk.OutboundApplied,
		observed: sdk.OutboundStatus{Persisted: current, ApplicationState: sdk.OutboundConfirmed,
			Observed: &sdk.OutboundSnapshotStatus{OutboundSnapshot: current, ApplicationState: sdk.OutboundConfirmed}}}
	router := outboundRouter(func() (outboundControl, error) { lookups.Add(1); return control, nil },
		common_errors.NewErrorMiddleware(common.HandlePossibleDockerError), middlewares.AuthMiddleware("synthetic-control-key"))
	server := httptest.NewServer(router)
	defer server.Close()
	for _, route := range []struct{ method, suffix string }{
		{http.MethodGet, ""}, {http.MethodGet, "/status"}, {http.MethodPut, "/snapshot"},
	} {
		for _, authorization := range []string{"", "Bearer wrong-key", "Basic synthetic-control-key", "Bearer synthetic-control-key"} {
			before := lookups.Load()
			request, err := http.NewRequest(route.method, server.URL+"/boxes/box1/network/outbound"+route.suffix,
				strings.NewReader(`{"mode":"enabled"}`))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", authorization)
			request.Header.Set("If-Match", `"rev-a"`)
			request.Header.Set("X-Boxlite-Outbound-Revision", "rev-b")
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if authorization == "Bearer synthetic-control-key" {
				if response.StatusCode != http.StatusOK || lookups.Load() != before+1 {
					t.Fatalf("authorized %s: status=%d lookups=%d", route.suffix, response.StatusCode, lookups.Load()-before)
				}
			} else if response.StatusCode != http.StatusUnauthorized || lookups.Load() != before {
				t.Fatalf("unauthorized %s reached control: status=%d lookups=%d", route.suffix, response.StatusCode, lookups.Load()-before)
			}
		}
	}
}
