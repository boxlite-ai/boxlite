package test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestCreateApiKeyPermissionSelection(t *testing.T) {
	sent := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.RequestURI() != "/api-keys" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
		for header, want := range map[string]string{
			"Accept":                    "application/json",
			"Content-Type":              "application/json",
			"X-BoxLite-Organization-ID": "test-org",
		} {
			if got := r.Header.Get(header); got != want {
				t.Errorf("%s = %q, want %q", header, got, want)
			}
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if string(body["name"]) != `"deployment"` {
			t.Errorf("unexpected key name: %s", body["name"])
		}
		sent <- string(body["permissions"])
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"name":"deployment","value":"fixture","createdAt":"2026-01-01T00:00:00Z","permissions":[],"expiresAt":null}`)
	}))
	defer server.Close()
	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
	client := apiclient.NewAPIClient(config)
	for _, tc := range []struct {
		name        string
		permissions []string
		want        string
	}{
		{"organization defaults", nil, ""},
		{"no permissions", []string{}, "[]"},
		{"explicit grant", []string{"read:apps"}, `["read:apps"]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key := apiclient.NewCreateApiKey("deployment", tc.permissions)
			req := client.ApiKeysAPI.CreateApiKey(context.Background()).XBoxLiteOrganizationID("test-org").CreateApiKey(*key)
			if _, _, err := req.Execute(); err != nil {
				t.Fatalf("create key: %v", err)
			}
			if got := <-sent; got != tc.want {
				t.Errorf("permissions field = %q, want %q", got, tc.want)
			}
		})
	}
}
