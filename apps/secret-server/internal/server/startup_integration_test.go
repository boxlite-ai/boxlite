package server

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/boxlite-ai/secret-server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStartupRejectsWrongPersistentKey(t *testing.T) {
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
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	provider, err := encryption.NewEnvKeyProvider("env:test", key)
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
	wrong := make([]byte, 32)
	wrong[0] = 1
	c := Config{Role: "write", Environment: "local", DatabaseURL: databaseURL, KeyID: "env:test", Key: base64.StdEncoding.EncodeToString(wrong), AuthMode: "dev", DevToken: "integration-token", Port: "0", ShutdownTimeout: 5 * time.Second}
	s, err := New(ctx, c)
	if err == nil {
		s.Close()
		t.Fatal("startup accepted the wrong persistent key")
	}
}

func TestPostgresStartupAndReadiness(t *testing.T) {
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
	c := Config{Role: "write", Environment: "local", DatabaseURL: databaseURL, KeyID: "env:test", Key: base64.StdEncoding.EncodeToString(make([]byte, 32)), AuthMode: "dev", DevToken: "integration-token", Port: "0", ShutdownTimeout: 5 * time.Second}
	s, err := New(ctx, c)
	if err != nil {
		t.Fatalf("startup: %v", err)
	}
	defer s.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() { done <- s.Run(runContext, listener) }()
	client := &http.Client{Timeout: 3 * time.Second}
	for _, path := range []string{"/health", "/ready"} {
		response, err := client.Get("http://" + listener.Addr().String() + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: status %d", path, response.StatusCode)
		}
	}
	s.db.Close()
	response, err := client.Get("http://" + listener.Addr().String() + "/ready")
	if err != nil {
		t.Fatalf("GET /ready after database close: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("GET /ready after database close: status %d", response.StatusCode)
	}
	response, err = client.Get("http://" + listener.Addr().String() + "/health")
	if err != nil {
		t.Fatalf("GET /health after database close: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET /health after database close: status %d", response.StatusCode)
	}
	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("shutdown: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("shutdown did not complete")
	}
}
