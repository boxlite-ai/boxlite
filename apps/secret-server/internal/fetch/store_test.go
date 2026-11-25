package fetch

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/attest"

	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/boxlite-ai/secret-server/internal/encryption"
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
	t.Run("audit batch is atomic", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_second_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.secret_id = '33333333-3333-3333-3333-333333333333'::uuid THEN RAISE EXCEPTION 'rejected audit'; END IF; RETURN NEW; END $$`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, err := pool.Exec(ctx, "DROP FUNCTION reject_second_audit() CASCADE")
			if err != nil {
				t.Error(err)
			}
		})
		if _, err := pool.Exec(ctx, "CREATE TRIGGER reject_second_audit BEFORE INSERT ON secret_access_log FOR EACH ROW EXECUTE FUNCTION reject_second_audit()"); err != nil {
			t.Fatal(err)
		}
		before := h.AuditFailures()
		h.record(ctx, audit{SecretID: first, Result: "ok"}, audit{SecretID: second, Result: "ok"})
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM secret_access_log WHERE result='ok'").Scan(&count); err != nil || count != 2 {
			t.Fatalf("partial audit batch persisted: count=%d error=%v", count, err)
		}
		if got := h.AuditFailures() - before; got != 2 {
			t.Fatalf("failed audit rows=%d, want 2", got)
		}
	})
	for _, result := range []string{"api_unavailable", "scope_mismatch", "store_unavailable", "attestation_unavailable"} {
		if err := h.store.record(ctx, audit{Result: result}); err != nil {
			t.Fatal(result, err)
		}
	}
	t.Run("real attestation and database ownership boundaries", func(t *testing.T) {
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		selector, err := attest.New(attest.Config{Attestors: []string{"dev"}, Environment: "local", Registry: `{}`}, nil, logger)
		if err != nil {
			t.Fatal(err)
		}
		for i, tc := range []struct {
			name, organization, box string
			status                  int
			result                  string
		}{
			{"organization allowed", org, "", 200, "ok"},
			{"box allowed", org, "box-a", 200, "ok"},
			{"foreign organization", second, "", 401, "scope_mismatch"},
			{"foreign box", org, "box-b", 401, "scope_mismatch"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				id := fmt.Sprintf("55555555-5555-5555-5555-%012d", i)
				row := encrypted(t, c, id)
				row.Name = fmt.Sprintf("BOUNDARY_%d", i)
				row.OrganizationID = tc.organization
				envelope, err := c.Encrypt(ctx, encryption.SecretContext{OrganizationID: row.OrganizationID, SecretID: id, Version: 1, Hosts: row.Hosts, Headers: row.Headers}, []byte("plaintext-marker"))
				if err != nil {
					t.Fatal(err)
				}
				row.Ciphertext = `\x` + hex.EncodeToString(envelope.Ciphertext)
				row.EncryptedDEK = `\x` + hex.EncodeToString(envelope.WrappedDEK.Ciphertext)
				if tc.box != "" {
					row.Scope = "box"
					row.BoxID = &tc.box
				}
				insert(row)
				auth := active()
				auth.Grants = []grant{{id}}
				var calls atomic.Int32
				api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var request map[string]string
					if json.NewDecoder(r.Body).Decode(&request) != nil || request["runner_id"] != "runner-a" {
						t.Error("API did not receive attested runner")
					}
					_ = json.NewEncoder(w).Encode(auth)
				}))
				defer api.Close()
				handler, err := New(pool, c, selector, api.URL, logger)
				if err != nil {
					t.Fatal(err)
				}
				server := httptest.NewServer(handler)
				defer server.Close()
				for _, proof := range []bool{false, true} {
					req, err := http.NewRequest(http.MethodPost, server.URL+"/internal/v1/fetch", strings.NewReader(requestBody))
					if err != nil {
						t.Fatal(err)
					}
					if proof {
						req.Header.Set(attest.DevHeader, "runner-a")
					}
					response, err := server.Client().Do(req)
					if err != nil {
						t.Fatal(err)
					}
					body, err := io.ReadAll(response.Body)
					response.Body.Close()
					if err != nil {
						t.Fatal(err)
					}
					status, result := tc.status, tc.result
					if !proof {
						status, result = 401, "attestation_failed"
						if calls.Load() != 0 {
							t.Fatal("missing proof reached API")
						}
					}
					if response.StatusCode != status {
						t.Fatalf("status %d, want %d: %s", response.StatusCode, status, body)
					}
					if status != 200 && strings.Contains(string(body), "plaintext-marker") {
						t.Fatal("denied request exposed plaintext")
					}
					var stored string
					if err := pool.QueryRow(ctx, "SELECT result FROM secret_access_log ORDER BY id DESC LIMIT 1").Scan(&stored); err != nil || stored != result {
						t.Fatalf("audit %s, want %s: %v", stored, result, err)
					}
				}
				if calls.Load() != 1 {
					t.Fatal("unexpected consumption calls", calls.Load())
				}
			})
		}
	})
	if err := h.store.record(ctx, audit{Result: "invalid-result"}); err == nil {
		t.Fatal("invalid audit result accepted")
	}
	t.Run("grant set exceeds read budget", func(t *testing.T) {
		var ids []string
		err := pool.QueryRow(ctx, `WITH inserted AS (
 INSERT INTO secret(organization_id,scope,name,name_normalized,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by)
 SELECT organization_id,scope,'BUDGET_'||n,'BUDGET_'||n,ciphertext,encrypted_dek,key_id,hosts,headers,repeat('p',1048576),created_by
 FROM secret CROSS JOIN generate_series(1,12) n WHERE id=$1 RETURNING id
 ) SELECT array_agg(id::text) FROM inserted`, first).Scan(&ids)
		if err != nil || len(ids) != 12 {
			t.Fatalf("create budget fixture: rows=%d error=%v", len(ids), err)
		}
		if _, err := h.store.load(ctx, ids[:1]); err != nil {
			t.Fatalf("individual row did not fit: %v", err)
		}
		if rows, err := h.store.load(ctx, ids); err == nil || len(rows) != 0 {
			t.Fatalf("oversized grant set was not rejected: rows=%d error=%v", len(rows), err)
		}
	})
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
