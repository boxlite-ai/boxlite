package healthcheck

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

// TestServiceDataDiskRefAssemblyContract checks the LLD §5.2 rule: the
// healthcheck carries dataDiskRef
// only when project, zone and disk name are all present; any missing part
// omits the whole field. Each case drives NewService itself — not a local
// mirror of its assembly condition — so a loosened condition (a partial ref
// reaching the wire) turns the suite red. The payload then goes through
// newHealthcheck and the real generated client onto an httptest server, so
// the assertions hold against the exact JSON the runner sends.
func TestServiceDataDiskRefAssemblyContract(t *testing.T) {
	payloads := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/runners/healthcheck" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
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

	// NewService builds its API client from the config singleton, which reads
	// these env keys; point it at the test server once for all cases.
	t.Setenv("BOXLITE_API_URL", server.URL)
	t.Setenv("BOXLITE_RUNNER_TOKEN", "wire-contract-test-token")

	for _, tc := range []struct {
		name     string
		project  string
		zone     string
		diskName string
		diskType string
		wantSent bool
	}{
		{
			name:     "all three env values present sends the complete ref",
			project:  "boxlite-prod-project",
			zone:     "us-central1-a",
			diskName: "boxlite-runner-data-host-1",
			diskType: "hyperdisk_balanced",
			wantSent: true,
		},
		{
			name:     "unset disk type serializes as an empty string on the wire",
			project:  "boxlite-prod-project",
			zone:     "us-central1-a",
			diskName: "boxlite-runner-data-host-1",
			wantSent: true,
		},
		{
			name:     "missing disk name omits the whole field",
			project:  "boxlite-prod-project",
			zone:     "us-central1-a",
			wantSent: false,
		},
		{
			name:     "missing zone omits the whole field",
			project:  "boxlite-prod-project",
			diskName: "boxlite-runner-data-host-1",
			wantSent: false,
		},
		{
			name:     "missing project omits the whole field",
			zone:     "us-central1-a",
			diskName: "boxlite-runner-data-host-1",
			wantSent: false,
		},
		{
			name:     "none present omits the whole field (AWS or local runner)",
			wantSent: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, err := NewService(&HealthcheckServiceConfig{
				Logger:             slog.Default(),
				Domain:             "runner.example.com",
				ApiPort:            8080,
				ProxyPort:          8080,
				Boxlite:            &blclient.Client{},
				GCPProjectID:       tc.project,
				GCPZone:            tc.zone,
				RunnerDataDiskName: tc.diskName,
				RunnerDataDiskType: tc.diskType,
			})
			if err != nil {
				t.Fatalf("NewService failed: %v", err)
			}

			// Assembly assertions on the production decision itself.
			if !tc.wantSent {
				if service.dataDiskRef != nil {
					t.Fatalf("dataDiskRef assembled despite a missing env key: %+v", service.dataDiskRef)
				}
			} else {
				if service.dataDiskRef == nil {
					t.Fatalf("dataDiskRef not assembled from a complete env set")
				}
				if got := service.dataDiskRef.GetProvider(); got != "gcp" {
					t.Fatalf("provider = %q, want gcp", got)
				}
				if got := service.dataDiskRef.GetProject(); got != tc.project {
					t.Fatalf("project = %q, want %q", got, tc.project)
				}
				if got := service.dataDiskRef.GetZone(); got != tc.zone {
					t.Fatalf("zone = %q, want %q", got, tc.zone)
				}
				if got := service.dataDiskRef.GetDiskName(); got != tc.diskName {
					t.Fatalf("diskName = %q, want %q", got, tc.diskName)
				}
				if got := service.dataDiskRef.GetDiskType(); got != tc.diskType {
					t.Fatalf("diskType = %q, want %q", got, tc.diskType)
				}
			}

			// Wire assertions through the production request path.
			healthcheck := service.newHealthcheck()
			req := service.client.RunnersAPI.RunnerHealthcheck(context.Background()).RunnerHealthcheck(*healthcheck)
			_, err = req.Execute()
			if err != nil {
				t.Fatal(err)
			}

			payload := <-payloads
			ref, present := payload["dataDiskRef"]
			if !tc.wantSent && present {
				t.Fatalf("dataDiskRef unexpectedly present in request body: %v", payload)
			}
			if !tc.wantSent {
				return
			}

			m, ok := ref.(map[string]any)
			if !ok {
				t.Fatalf("dataDiskRef is not an object: %v", ref)
			}
			for _, want := range []string{"provider", "project", "zone", "diskName", "diskType"} {
				if _, ok := m[want]; !ok {
					t.Fatalf("dataDiskRef missing %q: %v", want, m)
				}
			}
			if m["provider"] != "gcp" {
				t.Fatalf("provider = %v, want gcp", m["provider"])
			}
			if m["diskName"] != tc.diskName {
				t.Fatalf("diskName = %v, want %q", m["diskName"], tc.diskName)
			}
			if m["diskType"] != tc.diskType {
				t.Fatalf("diskType = %v, want %q", m["diskType"], tc.diskType)
			}
		})
	}
}
