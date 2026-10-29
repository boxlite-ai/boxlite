package cpumonitor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCPUIncidentImageSurvivesExitAndUpload(t *testing.T) {
	w := window{complete: true}
	w.add(map[string]counter{
		"winner": {identity: "one", seconds: 10, image: "registry.example/team/image:tag"},
		"other":  {identity: "two", seconds: 1000, image: "other:latest"},
	}, true)
	w.add(map[string]counter{
		"winner": {identity: "one", seconds: 30, image: "registry.example/team/image:tag"},
		"other":  {identity: "two", seconds: 1001, image: "other:latest"},
	}, true)
	w.add(map[string]counter{"other": {identity: "two", seconds: 1002, image: "other:latest"}}, true)
	bodies := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var uploaded map[string]any
		if err := json.NewDecoder(r.Body).Decode(&uploaded); err != nil {
			t.Error(err)
		}
		bodies <- uploaded
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	report, err := NewReporter(server.URL, "synthetic", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := report(context.Background(), w.finish(Incident{})); err != nil {
		t.Fatal(err)
	}
	uploaded := <-bodies
	if uploaded["boxId"] != "winner" || uploaded["image"] != "registry.example/team/image:tag" || uploaded["cpuSeconds"] != float64(20) || uploaded["samplingComplete"] != false {
		t.Fatalf("lost winning box image on exit/upload: %#v", uploaded)
	}
}

func TestCPUIncidentImageEmptyAndUnavailable(t *testing.T) {
	w := window{complete: true}
	assertImage := func(want any) {
		t.Helper()
		body, err := json.Marshal(w.finish(Incident{}))
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(body, &fields); err != nil {
			t.Fatal(err)
		}
		if image, exists := fields["image"]; !exists || image != want {
			t.Fatalf("image field = %#v, present=%v; want %#v", image, exists, want)
		}
	}
	assertImage(nil)
	w.add(map[string]counter{"empty": {identity: "p", seconds: 10}}, true)
	w.add(map[string]counter{"empty": {identity: "p", seconds: 20}}, true)
	assertImage("")
}
