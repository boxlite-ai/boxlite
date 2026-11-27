package secretstore

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/boxlite-ai/secret-server/internal/testdb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegration(t *testing.T) {
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set SECRET_TEST_DATABASE_URL for PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	_, testURL := testdb.Create(t, ctx, admin, dsn, false)
	pool, err := pgxpool.New(ctx, testURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	provider, err := encryption.NewEnvKeyProvider("env:test", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryption.NewCipher(provider)
	if err != nil {
		t.Fatal(err)
	}
	const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const box = "Box123456789"
	secret := func(id, name, value string) Secret {
		t.Helper()
		hosts := []string{"example.com"}
		headers := map[string]string{"Authorization": "Bearer {value}"}
		envelope, err := cipher.Encrypt(ctx, encryption.SecretContext{OrganizationID: org, SecretID: id, Version: 1, Hosts: hosts, Headers: headers}, []byte(value))
		if err != nil {
			t.Fatal(err)
		}
		return Secret{Metadata: Metadata{ID: id, Name: name, NormalizedName: strings.ToUpper(name), Hosts: hosts, Headers: headers, Placeholder: "placeholder", CreatedBy: "user"}, Envelope: envelope}
	}
	first := secret("10000000-0000-4000-8000-000000000001", "FIRST", "one")
	second := secret("10000000-0000-4000-8000-000000000002", "SECOND", "two")
	reject := func(context.Context, int, Secret) error { return errors.New("unexpected existing secret") }
	if _, err := InsertBoxSecrets(ctx, pool, org, box, nil, reject); err == nil {
		t.Fatal("empty transfer accepted")
	}
	result, err := InsertBoxSecrets(ctx, pool, org, box, []Secret{first, second}, reject)
	if err != nil || len(result) != 2 || !result[0].Inserted || !result[1].Inserted {
		t.Fatalf("insert: %+v %v", result, err)
	}
	metadata, err := ReadMetadata(ctx, pool, first.Metadata.ID)
	if err != nil || metadata.ID != first.Metadata.ID || metadata.Name != "FIRST" || metadata.Headers["Authorization"] != "Bearer {value}" {
		t.Fatalf("metadata: %+v %v", metadata, err)
	}
	if _, err := ReadMetadata(ctx, pool, "10000000-0000-4000-8000-000000000099"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing: %v", err)
	}
	seen := 0
	check := func(ctx context.Context, i int, stored Secret) error {
		seen++
		plain, err := cipher.Decrypt(ctx, encryption.SecretContext{OrganizationID: stored.Metadata.OrganizationID, SecretID: stored.Metadata.ID, Version: 1, Hosts: stored.Metadata.Hosts, Headers: stored.Metadata.Headers}, stored.Envelope)
		if err != nil || string(plain) != "one" || i != 0 {
			return errors.New("incorrect stored value")
		}
		clear(plain)
		return nil
	}
	retry := secret("10000000-0000-4000-8000-000000000003", "FIRST", "one")
	result, err = InsertBoxSecrets(ctx, pool, strings.ToUpper(org), box, []Secret{retry}, check)
	if err != nil || seen != 1 || result[0].ID != first.Metadata.ID || result[0].Inserted {
		t.Fatalf("retry: %+v %v", result, err)
	}
	if _, err := InsertBoxSecrets(ctx, pool, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", box, []Secret{retry}, check); !errors.Is(err, ErrBoxOrgMismatch) {
		t.Fatalf("organization precedence: %v", err)
	}
	newName := secret("10000000-0000-4000-8000-000000000004", "THIRD", "three")
	if _, err := InsertBoxSecrets(ctx, pool, org, box, []Secret{newName}, check); !errors.Is(err, ErrBoxSecretsExist) {
		t.Fatalf("new name: %v", err)
	}
	conflict := errors.New("payload conflict")
	if _, err := InsertBoxSecrets(ctx, pool, org, box, []Secret{retry}, func(context.Context, int, Secret) error { return conflict }); !errors.Is(err, conflict) {
		t.Fatalf("retry failure: %v", err)
	}
	invalid := second
	invalid.Metadata.ID = "10000000-0000-4000-8000-000000000005"
	invalid.Metadata.Placeholder = ""
	rollbackFirst := secret("10000000-0000-4000-8000-000000000008", "FIRST", "one")
	_, err = InsertBoxSecrets(ctx, pool, org, "Box987654321", []Secret{rollbackFirst, invalid}, reject)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName != "secret_placeholder_check" {
		t.Fatalf("second insert did not reach placeholder constraint: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM secret WHERE box_id=$1", "Box987654321").Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback left %d rows: %v", count, err)
	}

	// Concurrent first transfers must serialize and return the same stored ID.
	concurrentBox := "Box111111111"
	a := secret("10000000-0000-4000-8000-000000000006", "FIRST", "one")
	b := secret("10000000-0000-4000-8000-000000000007", "FIRST", "one")
	var wg sync.WaitGroup
	results := make(chan []Result, 2)
	errs := make(chan error, 2)
	for _, candidate := range []Secret{a, b} {
		wg.Add(1)
		go func(s Secret) {
			defer wg.Done()
			r, err := InsertBoxSecrets(ctx, pool, org, concurrentBox, []Secret{s}, func(context.Context, int, Secret) error { return nil })
			results <- r
			errs <- err
		}(candidate)
	}
	wg.Wait()
	r1, r2 := <-results, <-results
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	if r1[0].ID != r2[0].ID || r1[0].Inserted == r2[0].Inserted {
		t.Fatalf("concurrent results: %+v %+v", r1, r2)
	}

	lockedBox := "Box222222222"
	guard, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	if _, err := guard.Exec(ctx, "SELECT pg_advisory_xact_lock($1, hashtext($2))", boxLockClass, lockedBox); err != nil {
		t.Fatal(err)
	}
	deadline, stop := context.WithTimeout(ctx, 100*time.Millisecond)
	defer stop()
	if _, err := InsertBoxSecrets(deadline, pool, org, lockedBox, []Secret{a}, reject); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock wait: %v", err)
	}
	if err := guard.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM secret WHERE box_id=$1", lockedBox).Scan(&count); err != nil || count != 0 {
		t.Fatalf("timed-out transfer left %d rows: %v", count, err)
	}
}
