package main

import (
	"context"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/attest"
	"github.com/boxlite-ai/secret-server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3/lock"
)

func runtimeDatabase(t *testing.T, ctx context.Context) string {
	t.Helper()
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SECRET_TEST_DATABASE_URL is not set")
	}
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal("create test database pool")
	}
	t.Cleanup(admin.Close)
	_, databaseURL := testdb.Create(t, ctx, admin, dsn, false)
	for name, value := range map[string]string{
		"DATABASE_URL": databaseURL, "ENVIRONMENT": "local", "SECRET_SERVER_ROLE": "write",
		"SECRET_SERVER_AUTH_MODE": "dev", "SECRET_SERVER_DEV_TOKEN": "test-token",
		"SECRET_MASTER_KEY_ID": "env:test", "SECRET_MASTER_KEY_BASE64": base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"PORT": "8080", "SHUTDOWN_TIMEOUT_SEC": "5", "SECRET_SERVER_RUNNER_REGISTRY": "",
	} {
		t.Setenv(name, value)
	}
	return databaseURL
}

type runningServer struct {
	address <-chan string
	done    <-chan error
}

func startRuntime(t *testing.T, ctx context.Context) runningServer {
	t.Helper()
	runCtx, stop := context.WithCancel(ctx)
	address := make(chan string, 1)
	done := make(chan error, 1)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		done <- runWithListener(runCtx, nil, func(network, _ string) (net.Listener, error) {
			listener, err := net.Listen(network, "127.0.0.1:0")
			if err == nil {
				address <- listener.Addr().String()
			}
			return listener, err
		})
	}()
	t.Cleanup(func() {
		stop()
		select {
		case <-stopped:
		case <-time.After(6 * time.Second):
			t.Error("test server did not stop")
		}
	})
	return runningServer{address, done}
}

func (s runningServer) awaitAddress(t *testing.T, ctx context.Context) string {
	t.Helper()
	select {
	case address := <-s.address:
		return address
	case err := <-s.done:
		t.Fatalf("startup exited before listening: %v", err)
	case <-ctx.Done():
		t.Fatal("startup did not reach listen")
	}
	return ""
}

func runtimeStatus(t *testing.T, address, path, proof string) int {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, "http://"+address+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if proof != "" {
		request.Header.Set(attest.DevHeader, proof)
	}
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

func TestFetchRuntimeRequiresAttestation(t *testing.T) {
	for _, role := range []string{"fetch", "all"} {
		t.Run(role, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			t.Cleanup(cancel)
			runtimeDatabase(t, ctx)
			t.Setenv("SECRET_SERVER_ROLE", role)
			t.Setenv("SECRET_SERVER_ATTESTORS", "unknown")
			listenCalled := errors.New("listener reached")
			err := runWithListener(ctx, nil, func(_, _ string) (net.Listener, error) {
				return nil, listenCalled
			})
			if errors.Is(err, listenCalled) || err == nil || !strings.Contains(err.Error(), "runner attestation") {
				t.Errorf("invalid attestor configuration returned %v, want startup rejection before listen", err)
			}

			t.Setenv("SECRET_SERVER_ATTESTORS", "dev")
			t.Setenv("SECRET_SERVER_INTROSPECTION_URL", "http://api.invalid/internal/v1/credentials/introspect")
			err = runWithListener(ctx, nil, func(_, _ string) (net.Listener, error) { return nil, listenCalled })
			if errors.Is(err, listenCalled) || err == nil || !strings.Contains(err.Error(), "SECRET_SERVER_INTROSPECTION_URL") {
				t.Fatalf("invalid introspection URL returned %v, want startup rejection before listen", err)
			}
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				t.Error("request without valid proof or credential reached introspection")
				w.WriteHeader(500)
			}))
			defer api.Close()
			t.Setenv("SECRET_SERVER_INTROSPECTION_URL", api.URL)
			address := startRuntime(t, ctx).awaitAddress(t, ctx)
			for _, tc := range []struct {
				path, proof string
				status      int
			}{
				{"/internal/v1/fetch", "", 401},
				{"/internal/v1/fetch", "test-runner", 401},
				{"/internal/v1/fetch/child", "test-runner", 404},
			} {
				req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+address+tc.path, nil)
				if err != nil {
					t.Fatal(err)
				}
				if tc.proof != "" {
					req.Header.Set(attest.DevHeader, tc.proof)
				}
				resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				if resp.StatusCode != tc.status {
					t.Errorf("%s returned %d, want %d", tc.path, resp.StatusCode, tc.status)
				}
			}
		})
	}
}

func TestStartupWaitsForMigrationLock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	t.Cleanup(cancel)
	databaseURL := runtimeDatabase(t, ctx)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal("create migration lock pool")
	}
	t.Cleanup(pool.Close)
	held, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal("acquire migration lock connection")
	}
	t.Cleanup(held.Release)
	if _, err := held.Exec(ctx, "SELECT pg_advisory_lock($1)", lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}

	s := startRuntime(t, ctx)
	// Hold the database lock past the previous 15-second startup deadline.
	timer := time.NewTimer(17 * time.Second)
	defer timer.Stop()
	select {
	case err := <-s.done:
		t.Fatalf("startup exited while the migration lock was held: %v", err)
	case <-s.address:
		t.Fatal("startup listened before migrations finished")
	case <-timer.C:
	case <-ctx.Done():
		t.Fatal("test deadline expired before releasing migration lock")
	}
	if _, err := held.Exec(ctx, "SELECT pg_advisory_unlock($1)", lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}
	if got := runtimeStatus(t, s.awaitAddress(t, ctx), "/ready", ""); got != http.StatusOK {
		t.Fatalf("/ready after releasing migration lock returned %d, want 200", got)
	}
}
