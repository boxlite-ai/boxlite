package apiclient_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

// Exercise the generated request and decoder together, including empty pages
// and the required-nullable identity contract.
func TestOrganizationInventory(t *testing.T) {
	const metadata = `"organizationId":"00000000-0000-4000-8000-000000000001","name":"Example","createdAt":"2026-11-01T00:00:00Z","createdBy":"user","observedAt":"2026-11-01T00:00:00Z"`
	const creator = `"creator":{"userId":"user","email":"user@example.test","displayName":null,"emailVerified":false}`
	for _, tc := range []struct {
		name    string
		scope   string
		items   string
		invalid bool
	}{
		{"default full", "", `[{` + metadata + `,` + creator + `,"memberCount":2,"boxCount":3,"impactState":"not_impacted"}]`, false},
		{"all-state false verification", "all", `[{` + metadata + `,` + creator + `,"memberCount":2,"boxCount":3,"impactState":"not_impacted"}]`, false},
		{"all-state null creator", "all", `[{` + metadata + `,"creator":null,"memberCount":2,"boxCount":3,"impactState":"not_impacted"}]`, false},
		{"all-state unknown verification", "all", `[{` + metadata + `,"creator":{"userId":"user","email":null,"displayName":null},"memberCount":2,"boxCount":3,"impactState":"not_impacted"}]`, false},
		{"default empty", "", `[]`, false},
		{"all-state empty", "all", `[]`, false},
		{"missing required creator", "all", `[{` + metadata + `,"memberCount":2,"boxCount":3,"impactState":"not_impacted"}]`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/admin/organizations" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				query := r.URL.Query()
				if query.Get("boxCountScope") != tc.scope || query.Has("boxCountScope") != (tc.scope != "") {
					t.Errorf("unexpected scope query: %s", r.URL.RawQuery)
				}
				if len(query) != 1 && tc.scope != "" || len(query) != 0 && tc.scope == "" {
					t.Errorf("unexpected extra query: %s", r.URL.RawQuery)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"items":%s,"limit":50,"nextCursor":null,"observedAt":null}`, tc.items)
			}))
			defer server.Close()
			config := apiclient.NewConfiguration()
			config.Servers = apiclient.ServerConfigurations{{URL: server.URL + "/api"}}
			config.HTTPClient = server.Client()
			request := apiclient.NewAPIClient(config).AdminAPI.AdminListOrganizationsOverview(context.Background())
			if tc.scope != "" {
				request = request.BoxCountScope(tc.scope)
			}
			page, response, err := request.Execute()
			if response != nil {
				defer response.Body.Close()
			}
			if tc.invalid {
				if err == nil {
					t.Fatal("missing required creator decoded successfully")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Items) == 0 {
				return
			}
			if page.Items[0].BoxCount != 3 {
				t.Fatal("response lost Box statistics")
			}
			identity := page.Items[0].Creator.Get()
			switch tc.name {
			case "all-state false verification":
				if identity == nil || identity.EmailVerified == nil || *identity.EmailVerified {
					t.Fatal("false verification was lost")
				}
			case "all-state null creator":
				if identity != nil {
					t.Fatal("null creator was lost")
				}
			case "all-state unknown verification":
				if identity == nil || identity.EmailVerified != nil {
					t.Fatal("unknown verification became a known value")
				}
			}
		})
	}
}
