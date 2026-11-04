package healthcheck

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestHealthcheckPrivilegedWireContract(t *testing.T) {
	disabled, enabled := false, true
	for _, tc := range []struct {
		name       string
		privileged *bool
	}{
		{"omitted", nil},
		{"explicit false", &disabled},
		{"explicit true", &enabled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payloads := make(chan map[string]any, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/runners/healthcheck" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				if got := r.Header.Get("Content-Type"); got != "application/json" {
					t.Errorf("Content-Type = %q, want application/json", got)
				}
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				payloads <- payload
				w.WriteHeader(http.StatusNoContent)
			}))
			t.Cleanup(server.Close)
			config := apiclient.NewConfiguration()
			config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
			client := apiclient.NewAPIClient(config)
			healthcheck := apiclient.NewRunnerHealthcheck("wire-contract-test")
			if tc.privileged != nil {
				healthcheck.SetSupportsPrivileged(*tc.privileged)
			}
			if _, err := client.RunnersAPI.RunnerHealthcheck(context.Background()).RunnerHealthcheck(*healthcheck).Execute(); err != nil {
				t.Fatal(err)
			}
			payload := <-payloads
			if payload["appVersion"] != "wire-contract-test" {
				t.Fatalf("appVersion = %v", payload["appVersion"])
			}
			got, present := payload["supportsPrivileged"]
			if tc.privileged == nil {
				if present || len(payload) != 1 {
					t.Fatalf("unset option changed the request body: %v", payload)
				}
			} else if !present || got != *tc.privileged || len(payload) != 2 {
				t.Fatalf("supportsPrivileged = %v (present=%t), want %t; body = %v", got, present, *tc.privileged, payload)
			}
		})
	}
}
