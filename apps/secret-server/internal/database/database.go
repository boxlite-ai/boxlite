// Package database owns Secret Server schema initialization and key verification.
package database

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

const schemaVersion = 1

// Initialize applies the schema and verifies the configured key before readiness.
func Initialize(ctx context.Context, pool *pgxpool.Pool, cipher *encryption.Cipher) error {
	if err := Migrate(ctx, pool); err != nil {
		return err
	}
	return VerifyKey(ctx, pool, cipher)
}

// Migrate serializes embedded migrations with a PostgreSQL session lock.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	files, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		return fmt.Errorf("open migrations: %w", err)
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("create migration lock: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, files, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("create migration provider: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	version, err := provider.GetDBVersion(ctx)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version < schemaVersion {
		return fmt.Errorf("schema version %d is behind expected %d", version, schemaVersion)
	}
	if version > schemaVersion {
		log.Printf("warning: schema version %d is ahead of binary version %d", version, schemaVersion)
	}
	return nil
}
