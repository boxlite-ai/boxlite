package fetch

import (
	"bytes"
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

func TestCredentialAPIIntegration(t *testing.T) {
	endpoint := os.Getenv("SECRET_TEST_CREDENTIAL_API_URL")
	if endpoint == "" {
		t.Skip("run make test:apps:secret-server:credential-api")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
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
	cipher := cipherForTest(t)
	row := encrypted(t, cipher, first)
	envelope, err := row.envelope()
	if err != nil {
		t.Fatal(err)
	}
	headers, err := json.Marshal(row.Headers)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO secret(id,organization_id,scope,name,name_normalized,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by)
 VALUES($1,$2,'org',$3,$3,$4,$5,$6,$7,$8,$9,'test')`, first, org, row.Name, envelope.Ciphertext, envelope.WrappedDEK.Ciphertext, envelope.WrappedDEK.KeyID, row.Hosts, headers, row.Placeholder)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	binding, _ := json.Marshal(map[string]any{"runnerId": "runner-a", "boxId": "box-a", "organizationId": org, "secretIds": []string{first}})
	response, err := client.Post(endpoint+"/__test/issue", "application/json", bytes.NewReader(binding))
	if err != nil {
		t.Fatal(err)
	}
	var issued struct {
		Token string `json:"token"`
	}
	err = json.NewDecoder(response.Body).Decode(&issued)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !strings.HasPrefix(issued.Token, "bxsc_") {
		t.Fatal("production API did not issue credential")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	selector, err := attest.New(attest.Config{Attestors: []string{"dev"}, Environment: "local", Registry: `{}`}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := New(pool, cipher, selector, endpoint+"/internal/v1/credentials/introspect", logger)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	body, _ := json.Marshal(map[string]string{"credential": issued.Token})
	for _, tc := range []struct {
		name, runner string
		status       int
		result       string
	}{
		{"wrong runner does not consume", "runner-b", 401, "credential_invalid"},
		{"redeem", "runner-a", 200, "ok"},
		{"replay", "runner-a", 401, "credential_invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/internal/v1/fetch", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set(attest.DevHeader, tc.runner)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.status {
				t.Fatalf("status %d, want %d", response.StatusCode, tc.status)
			}
			if response.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("cacheable secret response")
			}
			if tc.status == 200 {
				var result struct {
					BoxID   string  `json:"box_id"`
					Secrets []value `json:"secrets"`
				}
				if json.Unmarshal(data, &result) != nil || result.BoxID != "box-a" || len(result.Secrets) != 1 || result.Secrets[0].Value != "plaintext-marker-"+first {
					t.Fatal("wrong decrypted secret response")
				}
			} else if bytes.Contains(data, []byte("plaintext-marker")) {
				t.Fatal("denied request exposed plaintext")
			}
			var auditResult string
			if err = pool.QueryRow(ctx, "SELECT result FROM secret_access_log ORDER BY id DESC LIMIT 1").Scan(&auditResult); err != nil || auditResult != tc.result {
				t.Fatalf("audit %s, want %s: %v", auditResult, tc.result, err)
			}
		})
	}
}
