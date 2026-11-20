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

// databaseURL selects the temporary database even if the original URL has database parameters.
func databaseURL(dsn, name string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	query := u.Query()
	query.Del("dbname")
	query.Del("database")
	u.RawQuery = query.Encode()
	return u.String(), nil
}

// Create creates and verifies an isolated database and registers its cleanup.
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
	temporaryURL, err := databaseURL(dsn, name)
	if err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(temporaryURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.ConnectConfig(ctx, config.ConnConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var actual string
	if err := conn.QueryRow(ctx, "SELECT current_database()").Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if actual != name {
		t.Fatalf("connected to database %q; want %q", actual, name)
	}
	return name, temporaryURL
}
