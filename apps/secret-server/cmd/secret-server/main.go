package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/boxlite-ai/secret-server/internal/server"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("secret server stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) > 0 {
		if len(args) != 1 || args[0] != "migrate" {
			return fmt.Errorf("usage: secret-server [migrate]")
		}
		url := os.Getenv("DATABASE_URL")
		if url == "" {
			return fmt.Errorf("DATABASE_URL is required")
		}
		ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		pool, err := pgxpool.New(ctx, url)
		if err != nil {
			return fmt.Errorf("configure database: invalid DATABASE_URL")
		}
		defer pool.Close()
		return database.Migrate(ctx, pool)
	}
	c, err := server.LoadConfig()
	if err != nil {
		return err
	}
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
