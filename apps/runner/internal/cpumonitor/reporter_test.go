package cpumonitor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestCPUIncidentReporterHTTPContract(t *testing.T) {
	status := 503
	var bodies []Incident
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/runners/me/cpu-incidents" || r.Header.Get("Authorization") != "Bearer synthetic" || r.Header.Get("X-BoxLite-Source") != "runner" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("wrong request: %s %s", r.Method, r.URL.Path)
		}
		var body Incident
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		bodies = append(bodies, body)
		w.WriteHeader(status)
	}))
	defer server.Close()
	report, err := NewReporter(server.URL+"/api/", "synthetic", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	event := Incident{EventID: "same-event", SamplingComplete: false}
	for _, check := range []struct {
		status      int
		retry, fail bool
	}{{503, true, true}, {429, true, true}, {400, false, true}, {401, false, true}, {204, false, false}} {
		status = check.status
		retry, err := report(context.Background(), event)
		if retry != check.retry || (err != nil) != check.fail {
			t.Fatalf("status %d: retry %v err %v", status, retry, err)
		}
	}
	for _, body := range bodies {
		if !reflect.DeepEqual(body, event) {
			t.Fatalf("retry changed body: %+v", body)
		}
	}
	for _, base := range []string{"", "file:///tmp/api", "https://user:password@example.com", "https://example.com?token=x"} {
		if _, err := NewReporter(base, "synthetic", server.Client()); err == nil {
			t.Fatalf("accepted invalid base %q", base)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := report(ctx, event); err == nil {
		t.Fatal("ignored cancellation")
	}
}
