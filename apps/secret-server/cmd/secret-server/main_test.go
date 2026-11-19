package main

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/boxlite-ai/secret-server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3/lock"
)

func TestWrongKeyDoesNotStartServer(t *testing.T) {
	if os.Getenv("SECRET_TEST_STARTUP_CHILD") == "1" {
		os.Args = []string{"secret-server"}
		main()
		return
	}
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set SECRET_TEST_DATABASE_URL for startup integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	_, databaseURL := testdb.Create(t, ctx, admin, dsn, false)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	provider, err := encryption.NewEnvKeyProvider("env:test", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryption.NewCipher(provider)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Initialize(ctx, pool, cipher); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	listener.Close()
	wrong := make([]byte, 32)
	wrong[0] = 1
	for name, value := range map[string]string{"SECRET_TEST_STARTUP_CHILD": "1", "DATABASE_URL": databaseURL, "ENVIRONMENT": "local", "SECRET_SERVER_ROLE": "write", "SECRET_SERVER_AUTH_MODE": "dev", "SECRET_SERVER_DEV_TOKEN": "integration-token", "SECRET_MASTER_KEY_ID": "env:test", "SECRET_MASTER_KEY_BASE64": base64.StdEncoding.EncodeToString(wrong), "PORT": port} {
		t.Setenv(name, value)
	}
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWrongKeyDoesNotStartServer$")
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil || err == nil || !strings.Contains(string(output), "database initialization failed") {
		t.Fatalf("wrong-key startup = %v, output %q", err, output)
	}
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get("http://" + address + "/ready")
	if err == nil {
		response.Body.Close()
		t.Fatal("server reported readiness with wrong key")
	}
}

func TestRunRejectsInvalidArgumentsAndMissingDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	for _, args := range [][]string{{"unknown"}, {"migrate", "extra"}} {
		if err := run(context.Background(), args); err == nil || !strings.Contains(err.Error(), "usage") {
			t.Errorf("run(%v) = %v; want usage error", args, err)
		}
	}
	if err := run(context.Background(), []string{"migrate"}); err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("missing database: %v", err)
	}
}

func TestMigrateUsesDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", ":invalid:")
	err := run(context.Background(), []string{"migrate"})
	if err == nil || !strings.Contains(err.Error(), "configure database") {
		t.Fatalf("run with DATABASE_URL = %v, want database configuration error", err)
	}
}

func TestMigrateInvalidURLRedactsPassword(t *testing.T) {
	const password = "fixture-password-marker"
	t.Setenv("DATABASE_URL", "postgres://localhost:999999/db?password="+password)
	err := run(context.Background(), []string{"migrate"})
	if err == nil || strings.Contains(err.Error(), password) {
		t.Fatalf("migration configuration error = %v; password must be redacted", err)
	}
}

func TestIntegration(t *testing.T) {
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SECRET_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	_, databaseURL := testdb.Create(t, ctx, admin, dsn, false)
	t.Setenv("DATABASE_URL", databaseURL)
	if err := run(ctx, []string{"migrate"}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('goose_db_version') IS NOT NULL").Scan(&exists); err != nil || !exists {
		t.Fatalf("migration table exists = %v, error = %v", exists, err)
	}
}

func TestMigrateSIGTERM(t *testing.T) {
	if os.Getenv("SECRET_TEST_SIGNAL_CHILD") == "1" {
		os.Args = []string{"secret-server", "migrate"}
		main()
		return
	}
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set SECRET_TEST_DATABASE_URL for signal integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	name, databaseURL := testdb.Create(t, ctx, admin, dsn, false)
	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("application_name", "secret-signal-test")
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	held, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	if _, err := held.Exec(ctx, "SELECT pg_advisory_lock($1)", lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}
	defer held.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", lock.DefaultLockID)
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMigrateSIGTERM$")
	cmd.Env = append(os.Environ(), "SECRET_TEST_SIGNAL_CHILD=1", "DATABASE_URL="+u.String())
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	for {
		var waiting bool
		err := admin.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND query LIKE '%pg_try_advisory_lock%')", name, "secret-signal-test").Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("child did not reach migration lock")
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	err = cmd.Wait()
	exitErr, ok := err.(*exec.ExitError)
	if !ok || exitErr.ProcessState.Sys().(syscall.WaitStatus).Signaled() {
		t.Fatalf("SIGTERM terminated process without graceful cancellation: %v", err)
	}
}
