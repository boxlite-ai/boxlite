package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/boxlite-ai/secret-server/internal/server"
)

func main() {
	if err := run(); err != nil {
		slog.Error("secret server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	c, err := server.LoadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	s, err := server.New(startup, c)
	if err != nil {
		return err
	}
	defer s.Close()
	listener, err := net.Listen("tcp", net.JoinHostPort("", c.Port))
	if err != nil {
		return err
	}
	return s.Run(ctx, listener)
}
