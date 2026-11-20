// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestProxyPermissionsOnSDKRequests(t *testing.T) {
	const roleBody = `{"name":"role","description":"Operates boxes","permissions":["write:boxes"]}`
	const roleResponse = `{"id":"role","name":"role","description":"Operates boxes","permissions":["write:boxes"],"isGlobal":false,"createdAt":"2026-11-18T00:00:00Z","updatedAt":"2026-11-18T00:00:00Z"}`
	operations := []struct {
		name, method, path, organization, body, response string
		execute                                          func(*apiclient.APIClient, []string) error
	}{
		{
			name: "create key", method: http.MethodPost, path: "/api/api-keys", organization: "org",
			body:     `{"name":"key","permissions":["write:boxes"]}`,
			response: `{"name":"key","value":"example","createdAt":"2026-11-18T00:00:00Z","permissions":["write:boxes"],"expiresAt":null}`,
			execute: func(client *apiclient.APIClient, grants []string) error {
				key := apiclient.NewCreateApiKey("key", []string{"write:boxes"})
				key.SetProxyPermissions(grants)
				_, _, err := client.ApiKeysAPI.CreateApiKey(context.Background()).
					XBoxLiteOrganizationID("org").CreateApiKey(*key).Execute()
				return err
			},
		},
		{
			name: "create role", method: http.MethodPost, path: "/api/organizations/org/roles",
			body: roleBody, response: roleResponse,
			execute: func(client *apiclient.APIClient, grants []string) error {
				role := apiclient.NewCreateOrganizationRole("role", "Operates boxes", []string{"write:boxes"})
				role.SetProxyPermissions(grants)
				_, _, err := client.OrganizationsAPI.CreateOrganizationRole(context.Background(), "org").
					CreateOrganizationRole(*role).Execute()
				return err
			},
		},
		{
			name: "update role", method: http.MethodPut, path: "/api/organizations/org/roles/role",
			body: roleBody, response: roleResponse,
			execute: func(client *apiclient.APIClient, grants []string) error {
				role := apiclient.NewUpdateOrganizationRole("role", "Operates boxes", []string{"write:boxes"})
				role.SetProxyPermissions(grants)
				_, _, err := client.OrganizationsAPI.UpdateOrganizationRole(context.Background(), "org", "role").
					UpdateOrganizationRole(*role).Execute()
				return err
			},
		},
	}
	grants := []struct {
		name   string
		values []string
	}{
		{name: "omitted"},
		{name: "granted", values: []string{"write:proxies"}},
		{name: "cleared", values: []string{}},
	}
	for _, operation := range operations {
		for _, grant := range grants {
			t.Run(operation.name+"/"+grant.name, func(t *testing.T) {
				var want map[string]json.RawMessage
				if err := json.Unmarshal([]byte(operation.body), &want); err != nil {
					t.Fatal(err)
				}
				if grant.values != nil {
					want["proxyPermissions"], _ = json.Marshal(grant.values)
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != operation.method || r.URL.RequestURI() != operation.path ||
						r.Header.Get("Content-Type") != "application/json" ||
						r.Header.Get("Authorization") != "Bearer test-token" ||
						r.Header.Get("X-BoxLite-Organization-ID") != operation.organization {
						t.Errorf("unexpected request: %s %s %v", r.Method, r.URL.RequestURI(), r.Header)
					}
					var body map[string]json.RawMessage
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if !reflect.DeepEqual(body, want) {
						t.Errorf("body = %v, want %v", body, want)
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(operation.response))
				}))
				t.Cleanup(server.Close)
				configuration := apiclient.NewConfiguration()
				configuration.Servers = apiclient.ServerConfigurations{{URL: server.URL + "/api"}}
				configuration.AddDefaultHeader("Authorization", "Bearer test-token")
				if err := operation.execute(apiclient.NewAPIClient(configuration), grant.values); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
