package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestFractionalCPUsCreateAndInformation(t *testing.T) {
	for _, cores := range []float64{0.125, 1.5, 2} {
		t.Run(fmt.Sprint(cores), func(t *testing.T) {
			var requests atomic.Int32
			response := fmt.Sprintf(`{"box_id":"fractional","name":"named","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":%v,"memory_mib":512}`, cores)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if r.Method == "POST" && r.URL.Path == "/v1/boxes" {
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body["cpus"] != cores {
						t.Errorf("wrong cpus: %v", body)
					}
					if _, exists := body["cpu_limit"]; exists {
						t.Error("obsolete cpu_limit sent")
					}
					fmt.Fprint(w, response)
				} else if r.Method == "GET" && r.URL.Path == "/v1/boxes" {
					fmt.Fprintf(w, `{"boxes":[%s]}`, response)
				} else if r.Method == "GET" && (r.URL.Path == "/v1/boxes/named" || r.URL.Path == "/v1/boxes/fractional") {
					fmt.Fprint(w, response)
				} else {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer rt.Close()
			ctx := context.Background()
			box, err := rt.Create(ctx, "alpine", WithCPUs(cores))
			if err != nil {
				t.Fatal(err)
			}
			defer box.Close()
			check := func(info *BoxInfo, err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
				if info.CPUs != cores {
					t.Fatalf("lost fractional cpus: %+v", info)
				}
			}
			check(box.Info(ctx))
			check(rt.GetInfo(ctx, "named"))
			infos, err := rt.ListInfo(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(infos) != 1 {
				t.Fatalf("unexpected list: %v", infos)
			}
			check(&infos[0], nil)
			if got := requests.Load(); got != 4 {
				t.Fatalf("expected one request per operation, got %d", got)
			}
		})
	}
}

func TestFractionalCPUsRejectsInvalidWithoutRequest(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.NotFound(w, r)
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	for _, cores := range []float64{0, -0.5, 0.124, 0.1251, math.NaN(), math.Inf(1)} {
		if _, err := rt.Create(context.Background(), "alpine", WithCPUs(cores)); err == nil {
			t.Fatalf("accepted invalid cpus %v", cores)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("invalid cpus sent %d requests", requests.Load())
	}
}
