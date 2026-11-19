package testdb

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCreateOverridesDatabaseQuery(t *testing.T) {
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SECRET_TEST_DATABASE_URL is not set")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("dbname", "postgres")
	u.RawQuery = q.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	name, result := Create(t, ctx, admin, u.String(), false)
	cfg, err := pgxpool.ParseConfig(result)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Database != name {
		t.Fatalf("database = %q, want %q", cfg.ConnConfig.Database, name)
	}
}
