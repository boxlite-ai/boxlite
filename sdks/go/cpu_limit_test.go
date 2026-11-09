package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestCPULimitValidation(t *testing.T) {
	for _, cores := range []float64{0, -0.5, 0.001, 0.1255, math.NaN(), math.Inf(1)} {
		cfg := &boxConfig{}
		WithCPULimit(cores)(cfg)
		if err := buildAndFreeCOptions("alpine", cfg); err == nil {
			t.Fatalf("accepted invalid CPU limit %v", cores)
		}
	}
}

func TestCPULimitQueryRefusesCanceledContextAndClosedRuntime(t *testing.T) {
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
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := rt.cpuLimit(ctx, "limited"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled context, got %v", err)
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := rt.cpuLimit(context.Background(), "limited"); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("expected closed runtime, got %v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("preflight rejection sent %d requests", requests.Load())
	}
}

func TestCPULimitCreateAndInformation(t *testing.T) {
	for _, limit := range []string{"null", "0.125"} {
		t.Run(limit, func(t *testing.T) {
			response := fmt.Sprintf(`{"box_id":"limited","name":"named","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":2,"memory_mib":512,"cpu_limit":%s}`, limit)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/v1/config":
					fmt.Fprint(w, `{"capabilities":{"cpu_limit_enabled":true}}`)
				case r.Method == "POST" && r.URL.Path == "/v1/boxes":
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if limit == "null" {
						if _, ok := body["cpu_limit"]; ok {
							t.Error("unset limit was sent")
						}
					} else if body["cpu_limit"] != 0.125 || body["cpus"] != float64(2) {
						t.Errorf("wrong creation request: %v", body)
					}
					fmt.Fprint(w, response)
				case r.Method == "GET" && r.URL.Path == "/v1/boxes":
					fmt.Fprintf(w, `{"boxes":[%s]}`, response)
				case r.Method == "GET" && (r.URL.Path == "/v1/boxes/named" || r.URL.Path == "/v1/boxes/limited"):
					fmt.Fprint(w, response)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer rt.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			opts := []BoxOption{WithCPUs(2)}
			if limit != "null" {
				opts = append(opts, WithCPULimit(0.125))
			}
			box, err := rt.Create(ctx, "alpine", opts...)
			if err != nil {
				t.Fatal(err)
			}
			defer box.Close()
			check := func(info *BoxInfo, err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
				if limit == "null" {
					if info.CPULimit != nil {
						t.Fatal("expected nil limit")
					}
				} else if info.CPULimit == nil || *info.CPULimit != 0.125 {
					t.Fatalf("lost CPU limit: %+v", info)
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
		})
	}
}
