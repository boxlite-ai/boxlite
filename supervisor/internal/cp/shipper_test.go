package cp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
)

func TestShipperBatchesAndRetries(t *testing.T) {
	var mu sync.Mutex
	var posts [][]api.LogLine
	failFirst := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.URL.Path != "/sv/v1/logs" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var batch []api.LogLine
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if failFirst {
			failFirst = false
			w.WriteHeader(http.StatusBadGateway) // first POST fails; the shipper must retry, not drop
			return
		}
		posts = append(posts, batch)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	cl, err := New(srv.URL, "tok", false)
	if err != nil {
		t.Fatal(err)
	}
	sh := NewShipper(cl)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); sh.Run(ctx) }()

	const total = 450
	for i := 0; i < total; i++ {
		sh.Emit(api.LogLine{Source: "web", Level: "info", Line: "l" + strconv.Itoa(i), Deployment: 1})
	}
	deadline := time.Now().Add(6 * time.Second)
	for {
		mu.Lock()
		n := 0
		for _, p := range posts {
			n += len(p)
		}
		mu.Unlock()
		if n == total {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("shipped %d of %d lines", n, total)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	// The first POST was refused, so the lines coalesce into fewer, larger
	// batches on retry; what matters is that none were lost or reordered and
	// no single POST exceeds the cap.
	for _, p := range posts {
		if len(p) > maxPerPost {
			t.Fatalf("batch too large: %d", len(p))
		}
	}
	if posts[0][0].Line != "l0" {
		t.Fatalf("order lost: first line %q", posts[0][0].Line)
	}
	if sh.Dropped() != 0 {
		t.Fatalf("dropped %d lines", sh.Dropped())
	}
}

func TestEmitNeverBlocks(t *testing.T) {
	cl, _ := New("http://127.0.0.1:1", "tok", false)
	sh := NewShipper(cl) // Run never started: the queue fills up
	start := time.Now()
	for i := 0; i < queueDepth*2; i++ {
		sh.Emit(api.LogLine{Line: "x"})
	}
	if time.Since(start) > time.Second {
		t.Fatal("Emit blocked")
	}
	if sh.Dropped() != queueDepth {
		t.Fatalf("dropped = %d, want %d", sh.Dropped(), queueDepth)
	}
}

func TestSnapshotURLTokenScoping(t *testing.T) {
	var gotAuth []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = append(gotAuth, r.Header.Get("Authorization"))
		w.Write([]byte("tgz"))
	}))
	defer srv.Close()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = append(gotAuth, "other:"+r.Header.Get("Authorization"))
		w.Write([]byte("tgz"))
	}))
	defer other.Close()

	cl, _ := New(srv.URL, "tok", false)
	ctx := context.Background()
	for _, snap := range []api.Snapshot{
		{ID: "snap_a"}, // → /sv/v1/snapshots/snap_a with token
		{ID: "snap_b", URL: "/sv/v1/snapshots/snap_b"},  // relative URL on the CP: with token
		{ID: "snap_c", URL: other.URL + "/presigned/x"}, // third-party host: no token
	} {
		rc, err := cl.Snapshot(ctx, snap)
		if err != nil {
			t.Fatal(err)
		}
		rc.Close()
	}
	if len(gotAuth) != 3 || gotAuth[0] != "Bearer tok" || gotAuth[1] != "Bearer tok" || gotAuth[2] != "other:" {
		t.Fatalf("auth headers: %v", gotAuth)
	}
}
