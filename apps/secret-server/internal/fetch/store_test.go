package fetch

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/attest"

	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/boxlite-ai/secret-server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegration(t *testing.T) {
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set SECRET_TEST_DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	_, dsn = testdb.Create(t, ctx, admin, dsn, false)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err = database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	c := cipherForTest(t)
	insert := func(s secret) {
		t.Helper()
		e, err := s.envelope()
		if err != nil {
			t.Fatal(err)
		}
		headers, _ := json.Marshal(s.Headers)
		_, err = pool.Exec(ctx, `INSERT INTO secret(id,organization_id,scope,box_id,name,name_normalized,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by)
 VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,'test')`, s.ID, s.OrganizationID, s.Scope, s.BoxID, s.Name, e.Ciphertext, e.WrappedDEK.Ciphertext, e.WrappedDEK.KeyID, s.Hosts, headers, s.Placeholder)
		if err != nil {
			t.Fatal(err)
		}
	}
	insert(encrypted(t, c, first))
	insert(encrypted(t, c, second))
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(active()) }))
	defer api.Close()
	v := verifierFunc(func(context.Context, http.Header) (attest.RunnerID, error) { return "runner-a", nil })
	h, err := New(pool, c, v, api.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h)
	defer server.Close()
	resp, err := http.Post(server.URL+"/internal/v1/fetch", "application/json", strings.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(data), "plaintext-marker") {
		t.Fatalf("fetch %d %s", resp.StatusCode, data)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM secret_access_log WHERE result='ok'").Scan(&count); err != nil || count != 2 {
		t.Fatalf("audit count %d %v", count, err)
	}
	for _, result := range []string{"api_unavailable", "scope_mismatch", "store_unavailable", "attestation_unavailable"} {
		if err := h.store.record(ctx, audit{Result: result}); err != nil {
			t.Fatal(result, err)
		}
	}
	if err := h.store.record(ctx, audit{Result: "invalid-result"}); err == nil {
		t.Fatal("invalid audit result accepted")
	}
	_, err = pool.Exec(ctx, "UPDATE secret SET disabled_at=now() WHERE id=$1", second)
	if err != nil {
		t.Fatal(err)
	}
	if w := call(h, requestBody, true); w.Code != 409 || strings.Contains(w.Body.String(), "plaintext-marker") {
		t.Fatal("disabled secret exposed", w.Code)
	}
	// Wrapping fields are mutable for KMS rewrapping; a large wrapping field must
	// be suppressed before it crosses the database boundary.
	_, err = pool.Exec(ctx, "UPDATE secret SET encrypted_dek=decode(repeat('ab',131073),'hex') WHERE id=$1", first)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.store.load(ctx, []string{first}); err == nil {
		t.Fatal("oversized row accepted")
	}
	if w := call(h, requestBody, true); w.Code != 503 {
		t.Fatal("oversized row not classified", w.Code)
	}
	_, err = pool.Exec(ctx, "DELETE FROM secret WHERE id=$1", second)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := h.store.load(ctx, []string{second})
	if err != nil || len(rows) != 0 {
		t.Fatal("absence not distinguished", err)
	}
}
