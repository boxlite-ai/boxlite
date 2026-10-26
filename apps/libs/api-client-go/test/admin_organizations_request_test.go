// Request tests for the generated Admin client. .openapi-generator-ignore
// excludes this directory, so regenerating the client keeps them.
package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

type sentRequest struct {
	method string
	path   string
	query  url.Values
}

// adminClient points the generated client at a local server and returns the
// requests it receives. The server answers `{}`, so decoding errors are expected
// and ignored: these tests assert only what the client sends.
func adminClient(t *testing.T) (*apiclient.APIClient, <-chan sentRequest) {
	t.Helper()
	requests := make(chan sentRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- sentRequest{method: r.Method, path: r.URL.Path, query: r.URL.Query()}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(server.Close)

	configuration := apiclient.NewConfiguration()
	configuration.Servers = apiclient.ServerConfigurations{{URL: server.URL + "/api"}}
	return apiclient.NewAPIClient(configuration), requests
}

func expectRequest(t *testing.T, got sentRequest, path string, query url.Values) {
	t.Helper()
	want := sentRequest{method: http.MethodGet, path: path, query: query}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request = %+v, want %+v", got, want)
	}
}

func TestAdminListOrganizationsOverviewSendsCreationWindowOnlyWhenSet(t *testing.T) {
	client, requests := adminClient(t)
	ctx := context.Background()

	_, _, _ = client.AdminAPI.AdminListOrganizationsOverview(ctx).Execute()
	expectRequest(t, <-requests, "/api/admin/organizations", url.Values{})

	_, _, _ = client.AdminAPI.AdminListOrganizationsOverview(ctx).
		CreatedFrom("2026-10-19T00:00:00Z").
		CreatedTo("2026-10-20T00:00:00Z").
		Execute()
	expectRequest(t, <-requests, "/api/admin/organizations", url.Values{
		"createdFrom": {"2026-10-19T00:00:00Z"},
		"createdTo":   {"2026-10-20T00:00:00Z"},
	})
}

func TestAdminGetOrganizationOverviewSendsIncludeOnlyWhenSet(t *testing.T) {
	client, requests := adminClient(t)
	ctx := context.Background()
	const organizationID = "00000000-0000-4000-8000-000000000011"
	path := "/api/admin/organizations/" + organizationID

	_, _, _ = client.AdminAPI.AdminGetOrganizationOverview(ctx, organizationID).Execute()
	expectRequest(t, <-requests, path, url.Values{})

	_, _, _ = client.AdminAPI.AdminGetOrganizationOverview(ctx, organizationID).Include("usage,activation").Execute()
	expectRequest(t, <-requests, path, url.Values{"include": {"usage,activation"}})
}
