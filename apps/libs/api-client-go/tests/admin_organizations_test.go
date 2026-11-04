package apiclient_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

// Exercise the generated request and anyOf decoder together, including the
// overlapping empty page and required-nullable identity contract.
func TestOrganizationProjection(t *testing.T) {
	const metadata = `"organizationId":"00000000-0000-4000-8000-000000000001","name":"Example","createdAt":"2026-11-01T00:00:00Z","createdBy":"user","observedAt":"2026-11-01T00:00:00Z"`
	const creator = `"creator":{"userId":"user","email":"user@example.test","displayName":null,"emailVerified":false}`
	for _, tc := range []struct {
		name       string
		projection string
		items      string
		full       bool
		invalid    bool
	}{
		{"default full", "", `[{` + metadata + `,` + creator + `,"memberCount":2,"boxCount":3,"impactState":"not_impacted"}]`, true, false},
		{"registration false verification", "registration", `[{` + metadata + `,` + creator + `}]`, false, false},
		{"registration null creator", "registration", `[{` + metadata + `,"creator":null}]`, false, false},
		{"registration unknown verification", "registration", `[{` + metadata + `,"creator":{"userId":"user","email":null,"displayName":null}}]`, false, false},
		{"default empty", "", `[]`, true, false},
		{"registration empty", "registration", `[]`, true, false},
		{"missing required creator", "registration", `[{` + metadata + `}]`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/admin/organizations" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				query := r.URL.Query()
				if query.Get("projection") != tc.projection || query.Has("projection") != (tc.projection != "") {
					t.Errorf("unexpected projection query: %s", r.URL.RawQuery)
				}
				if len(query) != 1 && tc.projection != "" || len(query) != 0 && tc.projection == "" {
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
			if tc.projection != "" {
				request = request.Projection(tc.projection)
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
			if tc.full {
				if page.AdminOrganizationOverviewPage == nil || page.AdminOrganizationRegistrationPage != nil {
					t.Fatalf("expected full/empty page, got %#v", page)
				}
				if tc.items != "[]" && page.AdminOrganizationOverviewPage.Items[0].BoxCount != 3 {
					t.Fatal("full response lost Box statistics")
				}
				return
			}
			if page.AdminOrganizationOverviewPage != nil || page.AdminOrganizationRegistrationPage == nil {
				t.Fatalf("expected registration page, got %#v", page)
			}
			identity := page.AdminOrganizationRegistrationPage.Items[0].Creator.Get()
			switch tc.name {
			case "registration false verification":
				if identity == nil || identity.EmailVerified == nil || *identity.EmailVerified {
					t.Fatal("false verification was lost")
				}
			case "registration null creator":
				if identity != nil {
					t.Fatal("null creator was lost")
				}
			case "registration unknown verification":
				if identity == nil || identity.EmailVerified != nil {
					t.Fatal("unknown verification became a known value")
				}
			}
		})
	}
}
