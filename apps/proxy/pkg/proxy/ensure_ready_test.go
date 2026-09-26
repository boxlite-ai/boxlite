// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

func newEnsureReadyProxy(t *testing.T, handler http.HandlerFunc) (*Proxy, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = server.URL
	clientConfig.AddDefaultHeader("Authorization", "Bearer proxy-key")

	return &Proxy{apiclient: apiclient.NewAPIClient(clientConfig)}, server
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

func TestEnsureBoxReadyCollapsesConcurrentCallsForOneBox(t *testing.T) {
	// One page load is dozens of requests arriving together; they must cost
	// the API one resume, not dozens.
	var calls atomic.Int32
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		// Hold the call open long enough that the others are demonstrably
		// in flight beside it rather than arriving after it returned.
		time.Sleep(150 * time.Millisecond)
		writer.WriteHeader(http.StatusNoContent)
	})

	const callers = 8
	var ready, done sync.WaitGroup
	ready.Add(callers)
	done.Add(callers)
	start := make(chan struct{})
	errs := make([]error, callers)
	for i := range callers {
		go func() {
			defer done.Done()
			ready.Done()
			<-start
			errs[i] = proxy.ensureBoxReady(context.Background(), "box-1")
		}()
	}
	ready.Wait()
	close(start)
	done.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d: ensureBoxReady() error = %v", i, err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("api called %d times for %d concurrent callers, want 1", got, callers)
	}

	// A different box is a different resume.
	if err := proxy.ensureBoxReady(context.Background(), "box-2"); err != nil {
		t.Fatalf("ensureBoxReady() error = %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("api called %d times after a second box, want 2", got)
	}
}

func TestEnsureBoxReadyAsksAgainOnceTheCallHasReturned(t *testing.T) {
	// The regression this replaces a TTL cache for. A box can stop at any
	// moment, including one second after it was reported ready; a readiness
	// answer retained past its call would let every request inside that window
	// skip the wake it needed and dial a stopped box.
	var calls atomic.Int32
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusNoContent)
	})

	for i := range 3 {
		if err := proxy.ensureBoxReady(context.Background(), "box-1"); err != nil {
			t.Fatalf("call %d: ensureBoxReady() error = %v", i, err)
		}
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("api called %d times for 3 sequential requests, want 3 — a success must not be remembered", got)
	}
}

func TestEnsureBoxReadyOutlivesTheCallerThatStartedIt(t *testing.T) {
	// With the calls collapsed, the first arrival owns the request everyone
	// else is waiting on. If it inherited that caller's cancellation, a
	// browser closing one tab would cancel the resume for every request
	// queued behind it.
	entered := make(chan struct{})
	release := make(chan struct{})
	var observed error
	proxy, _ := newEnsureReadyProxy(t, func(writer http.ResponseWriter, request *http.Request) {
		close(entered)
		select {
		case <-release:
			writer.WriteHeader(http.StatusNoContent)
		case <-request.Context().Done():
			observed = request.Context().Err()
		}
	})

	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderDone := make(chan error, 1)
	go func() { leaderDone <- proxy.ensureBoxReady(leaderCtx, "box-1") }()
	<-entered

	joinerDone := make(chan error, 1)
	go func() { joinerDone <- proxy.ensureBoxReady(context.Background(), "box-1") }()

	// The caller that started the resume gives up.
	cancelLeader()
	close(release)

	if err := <-joinerDone; err != nil {
		t.Fatalf("joiner saw %v; the resume must survive the caller that started it", err)
	}
	<-leaderDone
	if observed != nil {
		t.Fatalf("the API call was cancelled (%v) when its first caller went away", observed)
	}
}

func TestEnsureBoxReadyDoesNotSuppressRetriesAfterAFailedResume(t *testing.T) {
	// A failed resume must leave nothing behind: the next request has to reach
	// the API and try again.
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
		t.Fatalf("api called %d times, want 2 — the failure must not suppress the retry", got)
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
	// port validation, not in front of it, or an unusable port on a stopped
	// box becomes a way to spend the owner's compute.
	//
	// Zero is the case that used to get through. It is a number, so the old
	// ParseUint check accepted it, and only the dial refused it — after the
	// wake had already been paid for. The tunnel path rejected it all along,
	// which is how the two disagreed.
	for _, port := range []string{"0", "70000", "-1", "notaport"} {
		t.Run("port "+port, func(t *testing.T) { assertNoResumeForPort(t, port) })
	}
}

func assertNoResumeForPort(t *testing.T, port string) {
	t.Helper()
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
	request.Host = port + "-d-35334d4f5a336a70355a7531.proxy.test"
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("GetProxyTarget() = %#v, %v; want nil target and an error", target, err)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("ensure-ready called %d times for port %q, want 0", got, port)
	}
}

// A dial that never finds a listener must reach the client as something it can
// act on. httputil's default ErrorHandler writes a bare 502 with no body and
// no Retry-After, which is indistinguishable from a box that will never serve
// — the second half of POL-599.
func TestUpstreamErrorRendersAStartingBoxAsRetryable(t *testing.T) {
	for _, tc := range []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		wantRetry  string
	}{
		{
			name:       "guest port not listening yet",
			err:        fmt.Errorf("%w on box-1:3000: %w", errGuestDialFailed, errors.New("connection refused")),
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "box_starting",
			wantRetry:  strconv.Itoa(int(guestDialRetryWindow.Seconds())),
		},
		{
			name:       "anything else stays a gateway failure",
			err:        errors.New("resolve runner for box box-1: no such runner"),
			wantStatus: http.StatusBadGateway,
			wantCode:   "upstream_unavailable",
			wantRetry:  "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proxy := &Proxy{}
			router := gin.New()
			router.Use(common_errors.NewErrorMiddleware(func(_ *gin.Context, err error) common_errors.ErrorResponse {
				return common_errors.ErrorResponse{StatusCode: http.StatusInternalServerError, Message: err.Error()}
			}))
			router.GET("/", func(ctx *gin.Context) { proxy.renderUpstreamError(ctx, tc.err) })

			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.wantStatus)
			}
			if got := recorder.Header().Get("Retry-After"); got != tc.wantRetry {
				t.Fatalf("Retry-After = %q, want %q", got, tc.wantRetry)
			}
			var body struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("body %q is not the service's error shape: %v", recorder.Body.String(), err)
			}
			if body.Code != tc.wantCode {
				t.Fatalf("code = %q, want %q", body.Code, tc.wantCode)
			}
			if body.Message == "" {
				t.Fatal("message is empty; the client is told nothing")
			}
		})
	}
}
