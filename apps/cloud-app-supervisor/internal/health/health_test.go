package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestProbeWaitsForFirst2xx(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	res := Probe(context.Background(), srv.URL+"/healthz", 5*time.Second, 20*time.Millisecond)
	if !res.Healthy || res.Attempts != 3 || res.Status != http.StatusNoContent {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func TestProbeGivesUpAfterBudget(t *testing.T) {
	// A listener that is closed right away: every attempt is refused.
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()

	start := time.Now()
	res := Probe(context.Background(), url, 300*time.Millisecond, 50*time.Millisecond)
	if res.Healthy {
		t.Fatal("should not be healthy")
	}
	if res.Attempts < 2 || res.LastErr == "" {
		t.Fatalf("expected several refused attempts: %+v", res)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("overran the budget: %s", time.Since(start))
	}
}

func TestProbeNon2xxIsUnhealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	res := Probe(context.Background(), srv.URL, 200*time.Millisecond, 50*time.Millisecond)
	if res.Healthy || res.Status != 500 {
		t.Fatalf("unexpected: %+v", res)
	}
}

func TestProbeStopsOnCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	res := Probe(ctx, srv.URL, time.Minute, 20*time.Millisecond)
	if res.Healthy || time.Since(start) > 2*time.Second {
		t.Fatalf("cancel should stop the probe quickly: %+v after %s", res, time.Since(start))
	}
}
