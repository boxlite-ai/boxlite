// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/common-go/pkg/featureusage"
)

func usageReporter(t *testing.T, endpoint string) *featureusage.Reporter {
	t.Helper()
	reporter, err := featureusage.NewReporter(endpoint, "fixture-token", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return reporter
}

func TestPreviewForwardsWhileUsageCollectorIsBlocked(t *testing.T) {
	entered := make(chan []featureusage.Event, 1)
	release := make(chan struct{})
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var body struct {
			Events []featureusage.Event `json:"events"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		entered <- body.Events
		select {
		case <-release:
		case <-request.Context().Done():
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer collector.Close()
	defer close(release)
	reporter := usageReporter(t, collector.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go reporter.Run(ctx)
	for i := 0; i < featureusage.BatchSize-1; i++ {
		reporter.Record(featureusage.Event{BoxID: "OtherBox1234", Kind: featureusage.TunnelRequest})
	}
	runner := newFakeRunner(t)
	runner.start()
	api := newFakeAPI(t, runner, http.StatusNoContent)
	proxy := newWakeTestProxy(t, runner, api)
	proxy.featureUsage = reporter
	type forwardedResult struct {
		response previewResponse
		err      error
	}
	forwarded := make(chan forwardedResult, 1)
	go func() { response, err := previewGetResult(proxy); forwarded <- forwardedResult{response, err} }()
	var events []featureusage.Event
	select {
	case events = <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("usage collector was not reached")
	}
	select {
	case result := <-forwarded:
		if result.err != nil {
			t.Fatal(result.err)
		}
		response := result.response
		if response.Code != 200 || response.Body != "guest-ok" {
			t.Fatalf("forwarding failed: %#v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("forwarding waited for usage collector")
	}
	found := 0
	for _, event := range events {
		if event.BoxID == wakeTestBoxID {
			found++
			if event.Kind != featureusage.TunnelRequest || event.ID == "" || event.OccurredAt.IsZero() {
				t.Fatalf("incorrect evidence: %#v", event)
			}
		}
	}
	if found != 1 {
		t.Fatalf("usage events for forwarded request = %d", found)
	}
}

type usageRoundTripFunc func(*http.Request) (*http.Response, error)

func (f usageRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestUsageTransportCountsOnlySuccessfulUpstreamEvidence(t *testing.T) {
	for _, status := range []int{101, 200, 302, 400, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			reporter := usageReporter(t, "http://collector.invalid")
			response := &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("body-unread"))}
			transport := featureUsageTransport{next: usageRoundTripFunc(func(*http.Request) (*http.Response, error) { return response, nil }), reporter: reporter, boxID: wakeTestBoxID}
			got, err := transport.RoundTrip(httptest.NewRequest("GET", "http://guest/", nil))
			if got != response || err != nil {
				t.Fatal("upstream response changed")
			}
			body, _ := io.ReadAll(got.Body)
			if string(body) != "body-unread" {
				t.Fatal("usage observer consumed response body")
			}
			for i := 0; i < featureusage.QueueCapacity; i++ {
				reporter.Record(featureusage.Event{BoxID: "OtherBox1234", Kind: featureusage.TunnelRequest})
			}
			want := uint64(0)
			if status == 101 || (status >= 200 && status < 400) {
				want = 1
			}
			if reporter.Dropped() != want {
				t.Fatalf("observed drops=%d want=%d", reporter.Dropped(), want)
			}
		})
	}
}

func TestUsageTransportPreservesDialFailure(t *testing.T) {
	failure := errors.New("private-upstream-error")
	transport := featureUsageTransport{next: usageRoundTripFunc(func(*http.Request) (*http.Response, error) { return nil, failure })}
	if response, err := transport.RoundTrip(httptest.NewRequest("GET", "http://guest/", nil)); response != nil || err != failure {
		t.Fatal("dial failure changed")
	}
}

func TestConnectStillStreamsWhenUsageQueueIsFull(t *testing.T) {
	reporter := usageReporter(t, "http://collector.invalid")
	for i := 0; i < featureusage.QueueCapacity; i++ {
		reporter.Record(featureusage.Event{BoxID: "OtherBox1234", Kind: featureusage.TunnelRequest})
	}
	runner := newFakeRunner(t)
	runner.start()
	api := newFakeAPI(t, runner, http.StatusNoContent)
	proxy := newWakeTestProxy(t, runner, api)
	proxy.featureUsage = reporter
	server := httptest.NewServer(http.HandlerFunc(proxy.handleTunnelConnect))
	defer server.Close()
	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	authority := "3000-d-416243644566313233343536.proxy.test"
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatalf("CONNECT status=%d", response.StatusCode)
	}
	fmt.Fprint(conn, "GET / HTTP/1.1\r\nHost: guest\r\nConnection: close\r\n\r\n")
	response, err = http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "guest-ok" {
		t.Fatalf("stream body=%q error=%v", body, err)
	}
	if reporter.Dropped() != 1 {
		t.Fatalf("connection evidence drop=%d", reporter.Dropped())
	}
}
