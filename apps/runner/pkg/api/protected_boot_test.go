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
	cfg := ProtectedBootConfig{
		RunnerID: "8137cc0d-5d3f-43b8-aa32-b9304740269e",
		DoHURL:   "https://resolver.example.com/dns-query", DoHAddress: "1.1.1.1:443",
	}
	for _, tt := range []struct {
		name                                            string
		version                                         int
		configuredTLS, liveTLS, authenticated, assigned bool
		want                                            int
	}{
		{"plaintext", 0, true, false, true, true, http.StatusForbidden},
		{"wrong assignment", 0, true, true, true, false, http.StatusForbidden},
		{"wrong bearer", 0, true, true, false, true, http.StatusUnauthorized},
		{"http listener", 0, false, true, true, true, http.StatusNotFound},
		{"V2", 2, true, true, true, true, http.StatusNotFound},
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
			if tt.assigned {
				req.Header.Set("X-BoxLite-Runner-Id", cfg.RunnerID)
			}
			res := httptest.NewRecorder()
			engine.ServeHTTP(res, req)
			if res.Code != tt.want {
				t.Fatalf("HTTP status %d, want %d", res.Code, tt.want)
			}
		})
	}
	engine := gin.New()
	registerProtectedBoot(engine.Group("/", middlewares.AuthMiddleware("test-token")), cfg, 0, true)
	req := httptest.NewRequest(http.MethodGet, "https://runner.example.com/v1/outbound-proxy/bootstrap", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("X-BoxLite-Runner-Id", cfg.RunnerID)
	res := httptest.NewRecorder()
	engine.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("enrolled capability HTTP status %d", res.Code)
	}
}
