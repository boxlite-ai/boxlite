// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package featureusage

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func runReporter(t *testing.T, reporter *Reporter) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); reporter.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("reporter did not stop")
		}
	})
	return cancel, done
}

func fillBatch(t *testing.T, reporter *Reporter) {
	t.Helper()
	for i := 0; i < BatchSize; i++ {
		if !reporter.Record(Event{BoxID: "AbCdEf123456", Kind: TunnelConnection}) {
			t.Fatal("unexpected enqueue refusal")
		}
	}
}

func TestReporterBatchesSourceIdentityAndTimestamp(t *testing.T) {
	received := make(chan []Event, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/telemetry/feature-usage" || req.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("incorrect authenticated endpoint")
		}
		var body struct {
			Events []Event `json:"events"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		received <- body.Events
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	reporter, err := NewReporter(server.URL+"/api", "fixture-token", quietLogger())
	if err != nil {
		t.Fatal(err)
	}
	runReporter(t, reporter)
	sourceID := uuid.NewString()
	sourceTime := time.Date(2026, 9, 1, 1, 2, 3, 0, time.UTC)
	reporter.Record(Event{ID: sourceID, BoxID: "AbCdEf123456", Kind: SSH, OccurredAt: sourceTime})
	for i := 1; i < BatchSize; i++ {
		reporter.Record(Event{BoxID: "AbCdEf123456", Kind: TunnelRequest})
	}
	select {
	case events := <-received:
		if len(events) != BatchSize {
			t.Fatalf("batch length = %d", len(events))
		}
		if events[0].ID != sourceID || !events[0].OccurredAt.Equal(sourceTime) {
			t.Fatal("source identity/time changed")
		}
		if _, err := uuid.Parse(events[1].ID); err != nil {
			t.Fatal("generated ID is not a UUID")
		}
		if events[1].OccurredAt.IsZero() {
			t.Fatal("missing generated occurrence time")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("batch was not delivered")
	}
}

func TestFullQueueDoesNotWaitForCollector(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.Copy(io.Discard, req.Body)
		once.Do(func() { close(entered) })
		select {
		case <-release:
		case <-req.Context().Done():
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	defer close(release)
	reporter, err := NewReporter(server.URL, "fixture-token", quietLogger())
	if err != nil {
		t.Fatal(err)
	}
	runReporter(t, reporter)
	fillBatch(t, reporter)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("collector did not receive batch")
	}
	done := make(chan int, 1)
	go func() {
		accepted := 0
		for i := 0; i < QueueCapacity+1; i++ {
			if reporter.Record(Event{BoxID: "AbCdEf123456", Kind: TunnelConnection}) {
				accepted++
			}
		}
		done <- accepted
	}()
	select {
	case accepted := <-done:
		if accepted != QueueCapacity || reporter.Dropped() != 1 {
			t.Fatalf("accepted=%d dropped=%d", accepted, reporter.Dropped())
		}
	case <-time.After(time.Second):
		t.Fatal("producer waited for the blocked collector")
	}
}

type notificationHandler struct{ failures chan slog.Record }

func (h notificationHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h notificationHandler) Handle(_ context.Context, record slog.Record) error {
	if record.Message == "Cloud feature usage delivery unconfirmed" {
		h.failures <- record.Clone()
	}
	return nil
}
func (h notificationHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h notificationHandler) WithGroup(string) slog.Handler      { return h }

func TestReporterRejectsRedirectsAndCountsUnconfirmedDelivery(t *testing.T) {
	var redirected atomic.Int32
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { redirected.Add(1); w.WriteHeader(202) }))
	defer sink.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, sink.URL+"/private-token", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	failures := make(chan slog.Record, 1)
	reporter, err := NewReporter(server.URL, "fixture-token", slog.New(notificationHandler{failures}))
	if err != nil {
		t.Fatal(err)
	}
	runReporter(t, reporter)
	fillBatch(t, reporter)
	select {
	case record := <-failures:
		if reporter.Unconfirmed() != BatchSize || redirected.Load() != 0 {
			t.Fatal("delivery was retried or redirect followed")
		}
		record.Attrs(func(attr slog.Attr) bool {
			if attr.Key == "error_type" && attr.Value.String() != "http_error" {
				t.Errorf("unsafe error category: %v", attr)
			}
			return true
		})
	case <-time.After(3 * time.Second):
		t.Fatal("delivery failure was not accounted")
	}
}

func TestCancellationStopsBackgroundDelivery(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.Copy(io.Discard, req.Body)
		close(entered)
		select {
		case <-release:
		case <-req.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	reporter, err := NewReporter(server.URL, "fixture-token", quietLogger())
	if err != nil {
		t.Fatal(err)
	}
	cancel, done := runReporter(t, reporter)
	fillBatch(t, reporter)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("collector did not receive batch")
	}
	cancel()
	select {
	case <-done:
		if reporter.Record(Event{BoxID: "AbCdEf123456", Kind: SSH}) {
			t.Fatal("stopped reporter accepted an event")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown waited for collector")
	}
}

func TestInvalidReportingConfigurationIsSafeToDisable(t *testing.T) {
	for _, address := range []string{"file:///tmp/private", "http://user:private@collector", "http://collector/?private=value"} {
		reporter, err := NewReporter(address, "fixture-token", quietLogger())
		if reporter != nil || err == nil || err.Error() != "invalid feature usage reporting configuration" {
			t.Fatal("invalid configuration was not sanitized")
		}
		if reporter.Record(Event{}) {
			t.Fatal("disabled reporter accepted an event")
		}
	}
}
