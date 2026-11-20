package database

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/boxlite-ai/secret-server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3/lock"
)

// discardReads simulates a server that accepts writes but stops responding.
type discardReads struct {
	net.Conn
	discard *atomic.Bool
}

func (c discardReads) Read(p []byte) (int, error) {
	for {
		n, err := c.Conn.Read(p)
		if err != nil || !c.discard.Load() {
			return n, err
		}
	}
}

type disconnectingProvider struct {
	discard *atomic.Bool
	cancel  context.CancelFunc
}

func (p disconnectingProvider) Wrap(context.Context, []byte, []byte) (encryption.WrappedDEK, error) {
	p.discard.Store(true)
	p.cancel()
	return encryption.WrappedDEK{}, encryption.ErrProviderUnavailable
}

func (disconnectingProvider) Unwrap(context.Context, encryption.WrappedDEK, []byte) ([]byte, error) {
	return nil, encryption.ErrProviderUnavailable
}

func testRollbackCleanup(t *testing.T, ctx context.Context, admin *pgxpool.Pool, url string) {
	_, dsn := testdb.Create(t, ctx, admin, url, false)
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	var discard atomic.Bool
	var socket net.Conn
	config.ConnConfig.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		if err == nil {
			socket = conn
			return discardReads{Conn: conn, discard: &discard}, nil
		}
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	op, cancel := context.WithCancel(ctx)
	defer cancel()
	cipher, err := encryption.NewCipher(disconnectingProvider{discard: &discard, cancel: cancel})
	if err != nil {
		t.Fatal(err)
	}
	// Prevent a broken implementation from hanging the test indefinitely.
	timer := time.AfterFunc(5*time.Second, func() { _ = socket.Close() })
	defer timer.Stop()
	start := time.Now()
	err = VerifyKey(op, pool, cipher)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("rollback blocked for %v after cancellation: %v", elapsed, err)
	}
	if !errors.Is(err, encryption.ErrProviderUnavailable) {
		t.Fatalf("VerifyKey: %v", err)
	}
}

func testMigrationUnlockCleanup(t *testing.T, ctx context.Context, admin *pgxpool.Pool, url string) {
	_, dsn := testdb.Create(t, ctx, admin, url, false)
	setup, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(setup.Close)
	_, err = setup.Exec(ctx, `CREATE SCHEMA unlock_probe; CREATE FUNCTION unlock_probe.pg_advisory_unlock(bigint) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN pg_catalog.pg_advisory_unlock($1); END $$`)
	if err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = "unlock_probe,public,pg_catalog"
	config.ConnConfig.RuntimeParams["application_name"] = "secret-unlock-test"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	op, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Migrate(op, pool) }()
	wait, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	for {
		var active bool
		err := setup.QueryRow(wait, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='secret-unlock-test' AND wait_event='PgSleep')`).Scan(&active)
		if err != nil {
			t.Fatal(err)
		}
		if active {
			break
		}
		select {
		case <-wait.Done():
			t.Fatal("unlock did not start")
		case <-time.After(20 * time.Millisecond):
		}
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "unlock") {
			t.Fatalf("expected unlock error, got %v", err)
		}
	case <-time.After(3 * time.Second):
		err := <-done
		t.Fatalf("migration unlock blocked after cancellation: %v", err)
	}
	check, err := setup.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Release()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		var acquired bool
		if err := check.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", lock.DefaultLockID).Scan(&acquired); err != nil {
			t.Fatal(err)
		}
		if acquired {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("failed unlock left the migration lock held")
		case <-time.After(20 * time.Millisecond):
		}
	}
	if _, err := check.Exec(ctx, "SELECT pg_advisory_unlock($1)", lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}
}
