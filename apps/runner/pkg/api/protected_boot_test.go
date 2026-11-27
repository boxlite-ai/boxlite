package api

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	"github.com/gin-gonic/gin"
)

type unreadBody struct{ t *testing.T }

func (b unreadBody) Read([]byte) (int, error) {
	b.t.Error("request body was read before transport authority was established")
	return 0, io.EOF
}

func TestProtectedBootRejectsBeforeReadingRoute(t *testing.T) {
	cfg := NewProtectedBootConfig("https://control.example/api", "test-token")
	for _, tt := range []struct {
		name                                  string
		version                               int
		configuredTLS, liveTLS, authenticated bool
		want                                  int
	}{
		{"plaintext", 0, true, false, true, http.StatusForbidden},
		{"wrong bearer", 0, true, true, false, http.StatusUnauthorized},
		{"http listener", 0, false, true, true, http.StatusNotFound},
		{"V2", 2, true, true, true, http.StatusNotFound},
	} {
		t.Run(tt.name, func(t *testing.T) {
			engine := gin.New()
			engine.Use(func(ctx *gin.Context) {
				ctx.Next()
				if len(ctx.Errors) > 0 && !ctx.Writer.Written() {
					ctx.Status(http.StatusUnauthorized)
				}
			})
			protected := engine.Group("/", middlewares.AuthMiddleware("test-token"))
			registerProtectedBoot(protected, cfg, tt.version, tt.configuredTLS)
			req := httptest.NewRequest(http.MethodPost, "/v1/boxes/597da250-c3f6-4276-a0c2-25657a8fdeda/network/outbound/bootstrap", unreadBody{t})
			if tt.liveTLS {
				req.TLS = &tls.ConnectionState{}
			}
			if tt.authenticated {
				req.Header.Set("Authorization", "Bearer test-token")
			}
			res := httptest.NewRecorder()
			engine.ServeHTTP(res, req)
			if res.Code != tt.want {
				t.Fatalf("HTTP status %d, want %d", res.Code, tt.want)
			}
		})
	}
}

func TestProtectedBootCapabilityUsesOrdinaryRunnerIdentity(t *testing.T) {
	const runnerID = "8137cc0d-5d3f-43b8-aa32-b9304740269e"
	control := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runners/protected-bootstrap/identity" || r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(w, `{"runner_id":"`+runnerID+`"}`)
	}))
	defer control.Close()
	cfg := NewProtectedBootConfig(control.URL+"/api", "test-token")
	cfg.client.Transport = control.Client().Transport
	engine := gin.New()
	registerProtectedBoot(engine.Group("/", middlewares.AuthMiddleware("test-token")), cfg, 0, true)
	for id, status := range map[string]int{runnerID: http.StatusOK, "wrong-runner": http.StatusForbidden} {
		req := httptest.NewRequest(http.MethodGet, "https://runner.example.com/v1/outbound-proxy/bootstrap", nil)
		req.Header.Set("Authorization", "Bearer test-token")
		req.Header.Set("X-BoxLite-Runner-Id", id)
		res := httptest.NewRecorder()
		engine.ServeHTTP(res, req)
		if res.Code != status {
			t.Fatalf("capability for %s returned %d, want %d", id, res.Code, status)
		}
	}
}
