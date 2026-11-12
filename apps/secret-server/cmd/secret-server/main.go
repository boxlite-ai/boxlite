package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func run(ctx context.Context, args []string) error {
	if len(args) != 1 || args[0] != "migrate" {
		return fmt.Errorf("usage: secret-server migrate")
	}
	url := os.Getenv("SECRET_DATABASE_URL")
	if url == "" {
		return fmt.Errorf("SECRET_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return fmt.Errorf("configure database: %w", err)
	}
	defer pool.Close()
	return database.Migrate(ctx, pool)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
