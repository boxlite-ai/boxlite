package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3/lock"
)

func TestRunRejectsInvalidArgumentsAndMissingDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	for _, args := range [][]string{nil, {"unknown"}, {"migrate", "extra"}} {
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
	defer admin.Close()
	var nonce [8]byte
	rand.Read(nonce[:])
	name := fmt.Sprintf("secret_signal_%x", nonce)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
			t.Error(err)
		}
	}()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
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
