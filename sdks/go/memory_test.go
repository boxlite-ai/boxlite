package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMemoryMiBRequests(t *testing.T) {
	for _, mib := range []int{256, 257, 513, 768, 1536} {
		t.Run(fmt.Sprint(mib), func(t *testing.T) {
			var received map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/v1/boxes" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
				if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
					t.Error(err)
				}
				fmt.Fprintf(w, `{"box_id":"memory","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":1,"memory_mib":%d}`, mib)
			}))
			defer server.Close()
			runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			box, err := runtime.Create(context.Background(), "alpine", WithMemory(mib))
			if err != nil {
				t.Fatal(err)
			}
			defer box.Close()
			if received["memory_mib"] != float64(mib) {
				t.Fatalf("lost MiB: %v", received)
			}
		})
	}
}

func TestMemoryInvalidBeforeCConversion(t *testing.T) {
	for _, mib := range []int{-1, 0, 255, 2147483648} {
		cfg := &boxConfig{}
		WithMemory(mib)(cfg)
		if _, err := buildCOptions("alpine", cfg); !IsInvalidArgument(err) {
			t.Fatalf("accepted %d: %v", mib, err)
		}
	}
}
