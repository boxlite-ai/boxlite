package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/attest"
	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCredentialAPIIntegration(t *testing.T) {
	endpoint := os.Getenv("SECRET_TEST_CREDENTIAL_API_URL")
	if endpoint == "" {
		t.Skip("run make test:apps:secret-server:credential-api")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := runtimeDatabase(t, ctx)
	t.Setenv("SECRET_SERVER_ROLE", "all")
	t.Setenv("SECRET_SERVER_ATTESTORS", "dev")
	t.Setenv("SECRET_SERVER_INTROSPECTION_URL", endpoint+"/internal/v1/credentials/introspect")
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	runtime := startRuntime(t, ctx)
	fetchURL := "http://" + runtime.awaitAddress(t, ctx) + "/internal/v1/fetch"

	provider, err := encryption.NewEnvKeyProvider(os.Getenv("SECRET_MASTER_KEY_ID"), os.Getenv("SECRET_MASTER_KEY_BASE64"))
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryption.NewCipher(provider)
	if err != nil {
		t.Fatal(err)
	}
	const first = "22222222-2222-2222-2222-222222222222"
	const org = "11111111-1111-1111-1111-111111111111"
	hosts := []string{"api.example.com"}
	templates := map[string]string{"Authorization": "Bearer {value}"}
	placeholder := strings.Repeat("p", 920<<10)
	want := "plaintext-marker-" + strings.Repeat("a", 65536-len("plaintext-marker-"))
	envelope, err := cipher.Encrypt(ctx, encryption.SecretContext{
		OrganizationID: org, SecretID: first, Version: 1, Hosts: hosts, Headers: templates,
	}, []byte(want))
	if err != nil {
		t.Fatal(err)
	}
	headers, err := json.Marshal(templates)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO secret(id,organization_id,scope,name,name_normalized,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by)
 VALUES($1,$2,'org',$3,$3,$4,$5,$6,$7,$8,$9,'test')`, first, org, "KEY_2", envelope.Ciphertext, envelope.WrappedDEK.Ciphertext, envelope.WrappedDEK.KeyID, hosts, headers, placeholder)
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
	body, _ := json.Marshal(map[string]string{"credential": issued.Token})
	for _, tc := range []struct {
		name, runner string
		status       int
		result       string
	}{
		{"missing proof does not consume", "", 401, "attestation_failed"},
		{"wrong runner does not consume", "runner-b", 401, "credential_invalid"},
		{"redeem", "runner-a", 200, "ok"},
		{"replay", "runner-a", 401, "credential_invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, fetchURL, bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if tc.runner != "" {
				request.Header.Set(attest.DevHeader, tc.runner)
			}
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
					BoxID   string                                `json:"box_id"`
					Secrets []struct{ Value, Placeholder string } `json:"secrets"`
				}
				if json.Unmarshal(data, &result) != nil || result.BoxID != "box-a" || len(result.Secrets) != 1 || result.Secrets[0].Value != want || result.Secrets[0].Placeholder != placeholder {
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
