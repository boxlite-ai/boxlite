// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCustomDomainHealthProbeHosts(t *testing.T) {
	for _, tc := range []struct {
		host, method, path string
		health, lookup     bool
	}{
		{"10.0.0.8", "GET", "/health", true, false},
		{"10.0.0.8:4000", "GET", "/health", true, false},
		{"[2001:db8::8]:4000", "GET", "/health", true, false},
		{"proxy.boxlite.test", "GET", "/health", true, false},
		{"app.customer.com", "GET", "/health", false, true},
		{"10.0.0.8:4000", "GET", "/login", false, false},
		{"10.0.0.8:4000", "GET", "/callback", false, false},
		{"10.0.0.8:4000", "POST", "/health", false, false},
	} {
		t.Run(tc.host+tc.method+tc.path, func(t *testing.T) {
			proxy, asked := newAppDomainProxy(t, http.StatusNotFound)
			proxy.config.ProxyDomain = "proxy.boxlite.test"
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(tc.method, "http://proxy.boxlite.test"+tc.path, nil)
			ctx.Request.Host = tc.host
			proxy.handleHTTP(ctx)
			if tc.health {
				if len(ctx.Errors) != 0 || recorder.Code != http.StatusOK {
					t.Fatalf("health probe refused: status=%d errors=%v", recorder.Code, ctx.Errors)
				}
				var body struct {
					Status string `json:"status"`
				}
				if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body.Status != "ok" {
					t.Fatalf("invalid health response: body=%q err=%v", recorder.Body.String(), err)
				}
			} else if len(ctx.Errors) != 1 || !isStatus(ctx.Errors[0].Err, http.StatusNotFound) {
				t.Fatalf("request escaped exact-host refusal: %v", ctx.Errors)
			}
			if tc.lookup {
				if len(*asked) != 1 || (*asked)[0] != tc.host {
					t.Fatalf("customer health path bypassed lookup: %v", *asked)
				}
			} else if len(*asked) != 0 {
				t.Fatalf("non-customer health request queried API: %v", *asked)
			}
		})
	}
}
