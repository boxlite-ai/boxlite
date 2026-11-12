package server

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRoutes(t *testing.T) {
	for _, role := range []string{"write", "fetch", "all"} {
		t.Run(role, func(t *testing.T) {
			pingErr := error(nil)
			handler := routes(Config{Role: role, AuthMode: "dev", DevToken: "secret"}, func(context.Context) error { return pingErr }, nil)
			request := func(path, token string) int {
				r := httptest.NewRequest(http.MethodGet, path, nil)
				if token != "" {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w.Code
			}
			if got := request("/health", ""); got != 200 {
				t.Fatalf("health: %d", got)
			}
			if got := request("/ready", ""); got != 200 {
				t.Fatalf("ready: %d", got)
			}
			pingErr = errors.New("unavailable")
			if got := request("/ready", ""); got != 503 {
				t.Fatalf("failed readiness: %d", got)
			}
			if got := request("/health", ""); got != 200 {
				t.Fatalf("liveness depends on db: %d", got)
			}
			if got := request("/internal/v1/fetch", ""); got != 404 {
				t.Fatalf("unimplemented fetch: %d", got)
			}
			if got := request("/internal/v1/fetch/child", ""); got != 404 {
				t.Fatalf("fetch subtree: %d", got)
			}
			want := 401
			if role == "fetch" {
				want = 404
			}
			if got := request("/internal/v1/write", ""); got != want {
				t.Fatalf("write without auth: %d", got)
			}
			if got := request("/internal/v1/write", "secret"); got != 404 {
				t.Fatalf("unimplemented write: %d", got)
			}
		})
	}
}

func TestDatabaseErrorRedactsDetails(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{{&pgconn.PgError{Code: "28P01", Message: "secret-marker"}, "28P01"}, {&pgconn.PgError{Code: "secret-marker", Message: "secret-marker"}, "database connection rejected"}, {errors.New("secret-marker"), "database connection failed"}} {
		got := databaseError(tc.err).Error()
		if !strings.Contains(got, tc.want) || strings.Contains(got, "secret-marker") {
			t.Fatalf("unexpected category %q", got)
		}
	}
}

func TestRecoveryDoesNotLogPanicValue(t *testing.T) {
	var logs bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(old)
	r := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	recoverRequests(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("secret-marker-value") })).ServeHTTP(w, r)
	if w.Code != 500 || strings.Contains(logs.String(), "secret-marker-value") || strings.Contains(w.Body.String(), "secret-marker-value") {
		t.Fatalf("response or logs leaked panic: %d", w.Code)
	}
}

func TestRecoveryPreservesAbortHandler(t *testing.T) {
	defer func() {
		if recover() != http.ErrAbortHandler {
			t.Error("ErrAbortHandler was swallowed")
		}
	}()
	recoverRequests(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) })).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
}
