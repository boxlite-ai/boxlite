package server

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/boxlite-ai/secret-server/internal/attest"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestRoutes(t *testing.T) {
	for _, role := range []string{"write", "fetch", "all"} {
		t.Run(role, func(t *testing.T) {
			pingErr := error(nil)
			var runnerVerifier attest.Verifier
			wantFetch := http.StatusNotFound
			if role == "fetch" || role == "all" {
				selector, err := attest.New(attest.Config{Attestors: []string{attest.DevName}, Environment: "local"}, nil, slog.Default())
				if err != nil {
					t.Fatal(err)
				}
				runnerVerifier = selector
				wantFetch = http.StatusUnauthorized
			}
			handler := routes(Config{Role: role, AuthMode: "dev", DevToken: "secret"}, func(context.Context) error { return pingErr }, nil, runnerVerifier, nil)
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
			if got := request("/internal/v1/fetch", ""); got != wantFetch {
				t.Fatalf("unimplemented fetch: %d", got)
			}
			if got := request("/internal/v1/fetch/child", ""); got != wantFetch {
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

func TestHealthAndReadinessRejectOtherMethods(t *testing.T) {
	handler := routes(Config{}, func(context.Context) error { t.Error("unexpected ping"); return nil }, nil, nil, nil)
	for _, path := range []string{"/health", "/ready"} {
		t.Run(path, func(t *testing.T) {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, nil))
			if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
				t.Fatalf("status = %d, Allow = %q", w.Code, w.Header().Get("Allow"))
			}
		})
	}
}

func TestDatabaseErrorCategories(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"timeout", context.DeadlineExceeded, "database connection timed out"},
		{"canceled", context.Canceled, "database connection canceled"},
		{"rejected", &pgconn.PgError{Code: "28P01", Message: "secret-marker"}, "database connection rejected (SQLSTATE 28P01)"},
		{"invalid SQLSTATE", &pgconn.PgError{Code: "28!01", Message: "secret-marker"}, "database connection rejected"},
		{"network", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("secret-marker")}, "database network connection failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := databaseError(tc.err).Error(); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
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
