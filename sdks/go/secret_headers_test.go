//go:build boxlite_dev

package boxlite

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSecretHeadersRestRequest(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  map[string]string
	}{
		{"custom", `,"Headers":{"Authorization":"Bot {value}","X-Key":"{value}"}`, map[string]string{"Authorization": "Bot {value}", "X-Key": "{value}"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := make(chan map[string]json.RawMessage, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes" || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("unexpected request: %s %s %s", r.Method, r.URL.Path, r.Header.Get("Content-Type"))
				}
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, `{"box_id":"box1","status":"configured","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}`)
			}))
			defer server.Close()
			runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			var secret Secret
			if err := json.Unmarshal([]byte(`{"Name":"test","Value":"token","Hosts":["api.example.com"]`+tc.input+`}`), &secret); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			box, err := runtime.Create(ctx, "alpine", WithSecret(secret))
			if err != nil {
				t.Fatal(err)
			}
			defer box.Close()
			var secrets []struct {
				Name    string            `json:"name"`
				Value   string            `json:"value"`
				Hosts   []string          `json:"hosts"`
				Headers map[string]string `json:"headers"`
			}
			if err := json.Unmarshal((<-requests)["secrets"], &secrets); err != nil {
				t.Fatal(err)
			}
			if len(secrets) != 1 {
				t.Fatalf("want one secret, got %d", len(secrets))
			}
			got := secrets[0]
			if got.Name != "test" || got.Value != "token" || !reflect.DeepEqual(got.Hosts, []string{"api.example.com"}) {
				t.Fatal("secret fields changed across REST boundary")
			}
			if !reflect.DeepEqual(got.Headers, tc.want) {
				t.Fatalf("REST headers = %v, want %v", got.Headers, tc.want)
			}
		})
	}
}

func TestSecretHeadersRejectedBeforeRootfsSetup(t *testing.T) {
	runtime := newTestRuntime(t)
	var secret Secret
	if err := json.Unmarshal([]byte(`{"Name":"test","Value":"token","Hosts":["api.example.com"],"Headers":{"Bad Header":"{value}"}}`), &secret); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	box, err := runtime.Create(ctx, "", WithRootfsPath(t.TempDir()), WithSecret(secret))
	if box != nil {
		defer box.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "invalid header") {
		t.Fatalf("create should reject forwarded header before rootfs setup, got %v", err)
	}
}

func TestSecretHeadersRejectNULBeforeCConversion(t *testing.T) {
	runtime := newTestRuntime(t)
	for _, input := range []string{
		`{"Name":"test","Value":"token\u0000","Hosts":["api.example.com"],"Headers":{"Authorization":"Bearer {value}"}}`,
		`{"Name":"test","Value":"token","Hosts":["api.example.com"],"Headers":{"X-Key\u0000":"{value}"}}`,
		`{"Name":"test","Value":"token","Hosts":["api.example.com"],"Headers":{"X-Key":"{value}\u0000"}}`,
	} {
		var secret Secret
		if err := json.Unmarshal([]byte(input), &secret); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		box, err := runtime.Create(ctx, "", WithRootfsPath(t.TempDir()), WithSecret(secret))
		cancel()
		if box != nil {
			box.Close()
		}
		if !IsInvalidArgument(err) {
			t.Errorf("NUL must be rejected before C truncation, got %v", err)
		}
	}
}
