package healthcheck

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestHealthcheckReportsPrivilegedSupport(t *testing.T) {
	payloads := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/runners/healthcheck" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
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
	service := &Service{
		client:  apiclient.NewAPIClient(config),
		boxlite: healthcheckRuntime(t, false),
		domain:  "runner.test", apiPort: 8080, proxyPort: 8081,
	}
	for _, scheme := range []string{"http", "https"} {
		t.Run(scheme, func(t *testing.T) {
			service.tlsEnabled = scheme == "https"
			healthcheck := service.newHealthcheck()
			if _, err := service.client.RunnersAPI.RunnerHealthcheck(context.Background()).RunnerHealthcheck(*healthcheck).Execute(); err != nil {
				t.Fatal(err)
			}
			payload := <-payloads
			if payload["supportsPrivileged"] != true {
				t.Fatalf("supportsPrivileged = %v, want true; request = %v", payload["supportsPrivileged"], payload)
			}
			if payload["apiUrl"] != scheme+"://runner.test:8080" || payload["proxyUrl"] != scheme+"://runner.test:8081" {
				t.Fatalf("incorrect advertised endpoints: %v", payload)
			}
		})
	}
}
