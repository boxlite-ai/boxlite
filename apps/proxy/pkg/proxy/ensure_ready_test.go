// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
)

func newEnsureReadyProxy(t *testing.T, handler http.HandlerFunc) (*Proxy, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = server.URL
	clientConfig.AddDefaultHeader("Authorization", "Bearer proxy-key")

	return &Proxy{
		apiclient:           apiclient.NewAPIClient(clientConfig),
		boxEnsureReadyCache: common_cache.NewMapCache[bool](context.Background()),
	}, server
}

func TestEnsureBoxReadyCallsTheApiWithTheProxyCredential(t *testing.T) {
	var gotPath, gotMethod, gotAuth string
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, request *http.Request) {
		gotPath, gotMethod, gotAuth = request.URL.Path, request.Method, request.Header.Get("Authorization")
		writer.WriteHeader(http.StatusNoContent)
	})

	if err := proxy.ensureBoxReady(context.Background(), "box-1"); err != nil {
		t.Fatalf("ensureBoxReady() error = %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/preview/box-1/ensure-ready" {
		t.Fatalf("called %s %s, want POST /preview/box-1/ensure-ready", gotMethod, gotPath)
	}
	// The proxy authenticates as itself; no box key is forwarded, and no
	// organization identity is involved.
	if gotAuth != "Bearer proxy-key" {
		t.Fatalf("Authorization = %q, want the configured proxy credential", gotAuth)
	}
}

func TestEnsureBoxReadySuppressesRepeatCallsForOneBox(t *testing.T) {
	// One page load is dozens of requests; each must not ask for its own resume.
	var calls atomic.Int32
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusNoContent)
	})

	for i := 0; i < 5; i++ {
		if err := proxy.ensureBoxReady(context.Background(), "box-1"); err != nil {
			t.Fatalf("ensureBoxReady() error = %v", err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("api called %d times, want 1", got)
	}

	// A different box is a different resume.
	if err := proxy.ensureBoxReady(context.Background(), "box-2"); err != nil {
		t.Fatalf("ensureBoxReady() error = %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("api called %d times after a second box, want 2", got)
	}
}

func TestEnsureBoxReadyDoesNotSuppressRetriesAfterAFailedResume(t *testing.T) {
	// Caching an in-flight call would report a resume that later timed out as
	// readiness, and every request for the rest of the dedup window would skip
	// the retry it needed. Only a completed success may suppress.
	var calls atomic.Int32
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			writer.WriteHeader(http.StatusRequestTimeout)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	})

	if err := proxy.ensureBoxReady(context.Background(), "box-1"); !errors.Is(err, errEnsureReadyTimedOut) {
		t.Fatalf("first ensureBoxReady() error = %v, want errEnsureReadyTimedOut", err)
	}
	if err := proxy.ensureBoxReady(context.Background(), "box-1"); err != nil {
		t.Fatalf("second ensureBoxReady() error = %v, want the retry to reach the API", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("api called %d times, want 2 — the failure must not be cached", got)
	}

	// And the success that followed does suppress.
	if err := proxy.ensureBoxReady(context.Background(), "box-1"); err != nil {
		t.Fatalf("third ensureBoxReady() error = %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("api called %d times after a success, want 2", got)
	}
}

func TestEnsureBoxReadyReportsAResumeTimeoutAsRetryable(t *testing.T) {
	// 408 is what the API raises when a box does not reach running inside its
	// own window; the start is still in flight, so the caller must be able to
	// tell this apart and answer 503 instead of failing the request outright.
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusRequestTimeout)
	})

	err := proxy.ensureBoxReady(context.Background(), "box-1")
	if !errors.Is(err, errEnsureReadyTimedOut) {
		t.Fatalf("ensureBoxReady() error = %v, want errEnsureReadyTimedOut", err)
	}
}

func TestEnsureBoxReadyTreatsAHungApiAsRetryable(t *testing.T) {
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	err := proxy.ensureBoxReady(ctx, "box-1")
	if !errors.Is(err, errEnsureReadyTimedOut) {
		t.Fatalf("ensureBoxReady() error = %v, want errEnsureReadyTimedOut", err)
	}
}

func TestEnsureBoxReadySurfacesOtherFailures(t *testing.T) {
	// Not retryable-looking, and not something to swallow: the caller logs it
	// and lets the dial decide, rather than reporting the box as starting.
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusForbidden)
	})

	err := proxy.ensureBoxReady(context.Background(), "box-1")
	if err == nil || errors.Is(err, errEnsureReadyTimedOut) {
		t.Fatalf("ensureBoxReady() error = %v, want a plain failure", err)
	}
}

func TestGetProxyTargetDoesNotResumeForAnUnusablePort(t *testing.T) {
	// A malformed request must not start a box: the resume has to sit behind
	// port validation, not in front of it, or an out-of-range port on a
	// stopped box becomes a way to spend the owner's compute.
	var calls atomic.Int32
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusNoContent)
	})

	cacheContext := context.Background()
	publicCache := common_cache.NewMapCache[bool](cacheContext)
	activityCache := common_cache.NewMapCache[bool](cacheContext)
	boxID := "53MOZ3jp5Zu1"
	if err := publicCache.Set(cacheContext, boxID, true, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := activityCache.Set(cacheContext, boxID, true, time.Minute); err != nil {
		t.Fatal(err)
	}
	proxy.boxPublicCache = publicCache
	proxy.boxLastActivityUpdateCache = activityCache

	request := httptest.NewRequest(http.MethodGet, "http://proxy.test/", nil)
	request.Host = "70000-d-35334d4f5a336a70355a7531.proxy.test"
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("GetProxyTarget() = %#v, %v; want nil target and an error", target, err)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("ensure-ready called %d times for an invalid port, want 0", got)
	}
}
