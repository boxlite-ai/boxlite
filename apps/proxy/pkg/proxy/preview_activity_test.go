// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestPreviewActivityNavigation(t *testing.T) {
	for _, status := range []int{http.StatusCreated, http.StatusServiceUnavailable, 0} {
		name := http.StatusText(status)
		if status == 0 {
			name = "timeout"
		}
		t.Run(name, func(t *testing.T) {
			proxy := newTunnelProxy(t, http.StatusOK)
			calls := make(chan *http.Request, 100)
			cancelled := make(chan struct{}, 100)
			var count atomic.Int32
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/box/AbCdEf123456/last-activity" {
					count.Add(1)
					calls <- r
					if status == 0 {
						<-r.Context().Done()
						cancelled <- struct{}{}
						return
					}
					w.WriteHeader(status)
					return
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer api.Close()
			proxy.apiclient.GetConfig().Servers[0].URL = api.URL + "/api"
			for i := 0; i < 25; i++ {
				ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
				ctx.Request = httptest.NewRequest(http.MethodGet, "http://3000-AbCdEf123456.proxy.test/", nil)
				ctx.Request.Header.Set("Sec-Fetch-Mode", "navigate")
				ctx.Request.Header.Set("Sec-Fetch-Dest", "document")
				target, err := proxy.GetProxyTarget(ctx)
				stopActivityPoll(ctx)
				if err != nil || target == nil {
					t.Fatalf("telemetry blocked forwarding: %v", err)
				}
			}
			select {
			case request := <-calls:
				if request.Header.Get("X-BoxLite-Preview-Open") != "1" || request.Header.Get("Authorization") != "Bearer proxy-key" {
					t.Fatal("missing authenticated preview marker")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("admitted navigation never emitted a browser observation")
			}
			if status == 0 {
				select {
				case <-cancelled:
				case <-time.After(3 * time.Second):
					t.Fatal("preview delivery exceeded its timeout")
				}
			}
			select {
			case <-calls:
				t.Fatal("navigation burst bypassed cooldown")
			case <-time.After(100 * time.Millisecond):
			}
			if count.Load() != 1 {
				t.Fatalf("delivered %d observations, want 1", count.Load())
			}
		})
	}
}

func TestPreviewActivityExcludesAssetsAndDeniedNavigations(t *testing.T) {
	for _, dest := range []string{"image", "iframe", "empty", "document"} {
		t.Run(dest, func(t *testing.T) {
			proxy := newTunnelProxy(t, http.StatusOK)
			calls := make(chan struct{}, 1)
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-BoxLite-Preview-Open") != "" {
					calls <- struct{}{}
				}
				if dest == "document" {
					w.WriteHeader(http.StatusNotFound)
				} else {
					w.WriteHeader(http.StatusOK)
				}
			}))
			defer api.Close()
			proxy.apiclient.GetConfig().Servers[0].URL = api.URL + "/api"
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(http.MethodGet, "http://3000-AbCdEf123456.proxy.test/", nil)
			ctx.Request.Header.Set("Sec-Fetch-Mode", "navigate")
			ctx.Request.Header.Set("Sec-Fetch-Dest", dest)
			_, _ = proxy.GetProxyTarget(ctx)
			stopActivityPoll(ctx)
			select {
			case <-calls:
				t.Fatal("non-navigation or denied request emitted presence")
			case <-time.After(100 * time.Millisecond):
			}
		})
	}
}
