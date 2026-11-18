package server

import (
	"context"
	"encoding/base64"
	"net"
	"strings"
	"testing"
	"time"
)

func TestStartupRejectsUnavailableDatabaseWithoutLeakingDSN(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	address := listener.Addr().String()
	go func() {
		if conn, err := listener.Accept(); err == nil {
			conn.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c := Config{KeyID: "env:test", Key: base64.StdEncoding.EncodeToString(make([]byte, 32)), DatabaseURL: "postgres://secret-marker:secret-marker@" + address + "/secret-marker?sslmode=disable"}
	server, err := New(ctx, c)
	if server != nil {
		server.Close()
		t.Fatal("startup succeeded with an unavailable database")
	}
	if err == nil || !strings.Contains(err.Error(), "database") || strings.Contains(err.Error(), "secret-marker") {
		t.Fatalf("database startup error = %v", err)
	}
}
