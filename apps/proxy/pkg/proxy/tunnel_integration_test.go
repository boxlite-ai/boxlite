// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
)

func TestTunnelCapabilityIntegrationResolvesControlPlaneBeforeRunner(t *testing.T) {
	const (
		boxID = "AbCdEf123456"
		token = "t-0123456789abcdef0123456789abcdef"
	)
	requests := make(chan *http.Request, 1)
	proxy := tunnelIntegrationProxy(t, func(request *http.Request) (*http.Response, error) {
		requests <- request
		if request.URL.Path != "/preview/"+token+"/3000/box-id" {
			return tunnelIntegrationResponse(request, http.StatusNotFound, "not found"), nil
		}
		return tunnelIntegrationResponse(request, http.StatusOK, boxID), nil
	})
	ctx := context.Background()
	if err := proxy.boxRunnerCache.Set(
		ctx,
		boxID,
		RunnerInfo{ApiUrl: "://invalid-runner", ApiKey: "runner-key"},
		time.Minute,
	); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "3000-" + token + ".proxy.test:443"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want runner failure after capability resolution", response.Code)
	}
	select {
	case controlPlaneRequest := <-requests:
		if controlPlaneRequest.URL.Path != "/preview/"+token+"/3000/box-id" {
			t.Fatalf("control-plane path = %q", controlPlaneRequest.URL.Path)
		}
	case <-time.After(time.Second):
		t.Fatal("control plane did not resolve tunnel capability")
	}
}

func TestTunnelCapabilityIntegrationRejectsExpiredTokenBeforeRunnerLookup(t *testing.T) {
	const token = "t-0123456789abcdef0123456789abcdef"
	var controlPlanePaths []string
	proxy := tunnelIntegrationProxy(t, func(request *http.Request) (*http.Response, error) {
		controlPlanePaths = append(controlPlanePaths, request.URL.Path)
		if request.URL.Path != "/preview/"+token+"/3000/box-id" {
			return tunnelIntegrationResponse(request, http.StatusNotFound, "not found"), nil
		}
		return tunnelIntegrationResponse(request, http.StatusForbidden, "expired"), nil
	})
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "3000-" + token + ".proxy.test:443"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want expired capability rejection", response.Code)
	}
	if len(controlPlanePaths) != 1 || controlPlanePaths[0] != "/preview/"+token+"/3000/box-id" {
		t.Fatalf("control-plane requests = %q, want only the capability lookup", controlPlanePaths)
	}
}

type tunnelIntegrationRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip tunnelIntegrationRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func tunnelIntegrationProxy(t *testing.T, roundTrip tunnelIntegrationRoundTripper) *Proxy {
	t.Helper()
	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: "http://control-plane.test"}}
	config.HTTPClient = &http.Client{Transport: roundTrip}
	ctx := context.Background()
	return &Proxy{
		apiclient:      apiclient.NewAPIClient(config),
		boxRunnerCache: common_cache.NewMapCache[RunnerInfo](ctx),
		boxPublicCache: common_cache.NewMapCache[bool](ctx),
	}
}

func tunnelIntegrationResponse(request *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"text/plain"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}
}
