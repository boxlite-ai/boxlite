// Package testdb manages isolated PostgreSQL databases for integration tests.
package testdb

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Create creates an isolated database and registers its cleanup.
func Create(t *testing.T, ctx context.Context, admin *pgxpool.Pool, dsn string, ascii bool) (string, string) {
	t.Helper()
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("secret_test_%x", nonce)
	statement := "CREATE DATABASE " + pgx.Identifier{name}.Sanitize()
	if ascii {
		statement += " ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"
	}
	if _, err := admin.Exec(ctx, statement); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
			t.Errorf("drop test database: %v", err)
		}
	})
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return name, u.String()
}
