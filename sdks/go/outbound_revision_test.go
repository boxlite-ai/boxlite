//go:build unix

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func outboundNetwork(t *testing.T, handler http.HandlerFunc) *Network {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1" {
			_, _ = io.WriteString(w, `{"box_id":"box1","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}`)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	box, err := rt.Get(context.Background(), "box1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = box.Close() })
	network, err := box.Network()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = network.Close() })
	return network
}

func TestOutboundRevisionCrossFFI(t *testing.T) {
	requests := make(chan string, 3)
	policy := OutboundPolicy{Mode: NetworkModeEnabled, AllowNet: []string{}}
	snapshot := OutboundSnapshot{Policy: policy, Revision: "rev-a"}
	network := outboundNetwork(t, func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Method + " " + r.URL.Path
		switch r.URL.Path {
		case "/v1/boxes/box1/network/outbound":
			w.Header().Set("ETag", `"rev-a"`)
			_ = json.NewEncoder(w).Encode(policy)
		case "/v1/boxes/box1/network/outbound/status":
			_ = json.NewEncoder(w).Encode(OutboundStatus{Persisted: snapshot, Observed: &OutboundSnapshotStatus{OutboundSnapshot: snapshot, ApplicationState: OutboundConfirmed}, ApplicationState: OutboundConfirmed})
		case "/v1/boxes/box1/network/outbound/snapshot":
			if r.Header.Get("If-Match") != `"rev-a"` || r.Header.Get("X-Boxlite-Outbound-Revision") != "rev-b" {
				t.Errorf("wrong revision headers: %v", r.Header)
			}
			var actual map[string]any
			if err := json.NewDecoder(r.Body).Decode(&actual); err != nil {
				t.Error(err)
			}
			if len(actual) != 2 || actual["mode"] != "enabled" || actual["allow_net"] == nil {
				t.Errorf("wrong policy body: %#v", actual)
			}
			w.Header().Set("ETag", `"rev-b"`)
			_ = json.NewEncoder(w).Encode(policy)
		default:
			t.Errorf("unexpected route: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	})
	current, err := network.OutboundSnapshot(context.Background())
	if err != nil || current.Revision != "rev-a" || current.Policy.Mode != NetworkModeEnabled {
		t.Fatalf("snapshot: %+v, %v", current, err)
	}
	status, err := network.OutboundStatus(context.Background())
	if err != nil || status.ApplicationState != OutboundConfirmed || status.Observed == nil || status.Observed.Revision != "rev-a" {
		t.Fatalf("status: %+v, %v", status, err)
	}
	// The zero-value policy retains the enabled/empty-list defaults on the wire.
	outcome, err := network.ReplaceOutboundSnapshot(context.Background(), "rev-a", OutboundSnapshot{Revision: "rev-b"})
	if err != nil || outcome != OutboundApplied {
		t.Fatalf("replacement: %s, %v", outcome, err)
	}
	for _, expected := range []string{"GET /v1/boxes/box1/network/outbound", "GET /v1/boxes/box1/network/outbound/status", "PUT /v1/boxes/box1/network/outbound/snapshot"} {
		if actual := <-requests; actual != expected {
			t.Fatalf("request: %q, want %q", actual, expected)
		}
	}
}

func TestOutboundRevisionRefusalsCrossFFI(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		etag    string
		body    string
		code    ErrorCode
		outcome OutboundReplaceOutcome
	}{
		{name: "stale", status: 412, body: `{}`, outcome: OutboundPreconditionFailed},
		{name: "old", status: 404, body: `old server`, code: ErrUnsupported},
		{name: "missing-ack", status: 200, body: `{"mode":"enabled"}`, code: ErrNetwork},
		{name: "weak-ack", status: 200, etag: `W/"rev-b"`, body: `{"mode":"enabled"}`, code: ErrNetwork},
		{name: "wrong-policy", status: 200, etag: `"rev-b"`, body: `{"mode":"disabled"}`, code: ErrNetwork},
	} {
		t.Run(tc.name, func(t *testing.T) {
			network := outboundNetwork(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/boxes/box1/network/outbound/snapshot" {
					t.Errorf("unexpected fallback: %s", r.URL.Path)
				}
				if tc.etag != "" {
					w.Header().Set("ETag", tc.etag)
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			outcome, err := network.ReplaceOutboundSnapshot(context.Background(), "rev-a", OutboundSnapshot{Revision: "rev-b"})
			if tc.code != 0 {
				if !networkErrorCode(err, tc.code) || outcome != "" {
					t.Fatalf("got %s, %v", outcome, err)
				}
			} else if err != nil || outcome != tc.outcome {
				t.Fatalf("got %s, %v", outcome, err)
			}
		})
	}
}

func TestOutboundStatusDoesNotWaitForWriterCrossFFI(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	network := outboundNetwork(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			close(entered)
			<-release
			w.Header().Set("ETag", `"rev-b"`)
			_, _ = io.WriteString(w, `{"mode":"disabled"}`)
		} else {
			_, _ = io.WriteString(w, `{"persisted":{"policy":{"mode":"enabled"},"revision":"rev-a"},"observed":{"policy":{"mode":"enabled"},"revision":"rev-a","application_state":"confirmed"},"application_state":"uncertain","pending_revision":"rev-b"}`)
		}
	})
	t.Cleanup(unblock)
	type result struct {
		outcome OutboundReplaceOutcome
		err     error
	}
	writer := make(chan result, 1)
	go func() {
		outcome, err := network.ReplaceOutboundSnapshot(context.Background(), "rev-a", OutboundSnapshot{Revision: "rev-b", Policy: OutboundPolicy{Mode: NetworkModeDisabled}})
		writer <- result{outcome, err}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("writer did not reach HTTP server")
	}
	read := make(chan error, 1)
	go func() {
		status, err := network.OutboundStatus(context.Background())
		if err == nil && (status.ApplicationState != OutboundUncertain || status.PendingRevision != "rev-b") {
			err = errors.New("lost pending status")
		}
		read <- err
	}()
	select {
	case err := <-read:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("status waited for the pending writer")
	}
	unblock()
	select {
	case result := <-writer:
		if result.err != nil || result.outcome != OutboundApplied {
			t.Fatalf("writer: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("writer did not complete")
	}
}

func TestOutboundRevisionInvalidInputsDoNotDispatch(t *testing.T) {
	requests := make(chan struct{}, 16)
	network := outboundNetwork(t, func(w http.ResponseWriter, r *http.Request) { requests <- struct{}{}; http.Error(w, "unexpected", 500) })
	for _, expected := range []string{"", "rev-a\x00suffix", "bad value", "bad\nvalue", "中文", strings.Repeat("a", 129)} {
		outcome, err := network.ReplaceOutboundSnapshot(context.Background(), expected, OutboundSnapshot{Revision: "rev-b"})
		if !networkErrorCode(err, ErrInvalidArgument) || outcome != "" {
			t.Fatalf("accepted expected %q: %s, %v", expected, outcome, err)
		}
	}
	for _, revision := range []string{"initial", "rev-a", "rev-b\x00suffix", ""} {
		_, err := network.ReplaceOutboundSnapshot(context.Background(), "rev-a", OutboundSnapshot{Revision: revision})
		if !networkErrorCode(err, ErrInvalidArgument) {
			t.Fatalf("accepted candidate %q: %v", revision, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := network.OutboundStatus(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if _, err := network.ReplaceOutboundSnapshot(ctx, "rev-a", OutboundSnapshot{Revision: "rev-b"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if err := network.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := network.OutboundSnapshot(context.Background()); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("closed handle: %v", err)
	}
	var absent *Network
	if _, err := absent.OutboundStatus(context.Background()); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("nil handle: %v", err)
	}
	select {
	case <-requests:
		t.Fatal("invalid or cancelled call crossed FFI into HTTP")
	default:
	}
}

func TestOutboundRevisionTokenBoundariesCrossFFI(t *testing.T) {
	for _, tc := range []struct {
		name, expected, candidate string
	}{
		{name: "initial-to-maximum", expected: "initial", candidate: strings.Repeat("Az09-_", 21) + "aZ"},
		{name: "maximum-to-short", expected: strings.Repeat("a", 128), candidate: "b"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := make(chan struct{}, 16)
			network := outboundNetwork(t, func(w http.ResponseWriter, r *http.Request) {
				requests <- struct{}{}
				if r.Method != http.MethodPut || r.URL.Path != "/v1/boxes/box1/network/outbound/snapshot" ||
					r.Header.Get("If-Match") != `"`+tc.expected+`"` || r.Header.Get("X-Boxlite-Outbound-Revision") != tc.candidate {
					t.Errorf("revision changed across FFI: %s %s %v", r.Method, r.URL.Path, r.Header)
				}
				w.Header().Set("ETag", `"`+tc.candidate+`"`)
				_, _ = io.WriteString(w, `{"mode":"enabled","allow_net":[]}`)
			})
			outcome, err := network.ReplaceOutboundSnapshot(context.Background(), tc.expected, OutboundSnapshot{Revision: tc.candidate})
			if err != nil || outcome != OutboundApplied || len(requests) != 1 {
				t.Fatalf("boundary replacement: %s, %v; requests=%d", outcome, err, len(requests))
			}
		})
	}
}
