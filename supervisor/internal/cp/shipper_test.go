package cp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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

func TestPendingKeepsTheNewestAndAnnouncesDrops(t *testing.T) {
	cl, _ := New("http://127.0.0.1:1", "tok", false)
	sh := NewShipper(cl)
	for i := 0; i < maxPending+3; i++ {
		sh.enqueue(api.LogLine{Source: "web", Line: "l" + strconv.Itoa(i)})
	}
	if sh.Dropped() != 3 || sh.pending.len() != maxPending {
		t.Fatalf("dropped=%d pending=%d", sh.Dropped(), sh.pending.len())
	}
	if first := sh.pending.peek(1)[0].Line; first != "l3" {
		t.Fatalf("oldest kept line = %q, want l3", first)
	}
	sh.announceDrops()
	all := sh.pending.peek(maxPending)
	last := all[len(all)-1]
	if last.Source != api.SourceSystem || last.Level != api.LevelError || !strings.Contains(last.Line, "dropped 3 line(s)") {
		t.Fatalf("drop announcement: %+v", last)
	}
	if all[len(all)-2].Line != "l"+strconv.Itoa(maxPending+2) {
		t.Fatalf("newest line lost: %+v", all[len(all)-2])
	}
	sh.pending.discard(maxPending)
	sh.announceDrops() // the announcement itself pushed one more line out
	if got := sh.pending.peek(1); len(got) != 1 || !strings.Contains(got[0].Line, "dropped 1 line(s)") {
		t.Fatalf("second announcement: %+v", got)
	}
	sh.announceDrops()
	if sh.pending.len() != 1 {
		t.Fatal("nothing new was dropped, so nothing new may be announced")
	}
}

func TestPostReportsTheErrorBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_request","message":"too many lines"}`))
	}))
	defer srv.Close()
	cl, _ := New(srv.URL, "tok", false)
	err := cl.PostStatus(context.Background(), api.Status{Deployment: 1, Phase: api.PhaseLive})
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != http.StatusBadRequest || !strings.Contains(he.Body, "too many lines") {
		t.Fatalf("error = %#v", err)
	}
}

func TestSnapshotStallIsAnError(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sv/v1/snapshots/headers":
			// Never answers at all.
		case "/sv/v1/snapshots/body":
			w.Header().Set("Content-Type", "application/gzip")
			w.Write([]byte("partial"))
			w.(http.Flusher).Flush()
		case "/sv/v1/snapshots/slow":
			// Slow but steady: a byte every 50 ms is not a stall.
			for i := 0; i < 8; i++ {
				w.Write([]byte("x"))
				w.(http.Flusher).Flush()
				time.Sleep(50 * time.Millisecond)
			}
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	cl, _ := New(srv.URL, "tok", false)
	cl.SnapshotStall = 200 * time.Millisecond

	start := time.Now()
	_, err := cl.Snapshot(context.Background(), api.Snapshot{ID: "headers"})
	if !errors.Is(err, ErrSnapshotStalled) || time.Since(start) > 2*time.Second {
		t.Fatalf("no response headers: err=%v after %s", err, time.Since(start))
	}

	start = time.Now()
	rc, err := cl.Snapshot(context.Background(), api.Snapshot{ID: "body"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(rc)
	rc.Close()
	if !errors.Is(err, ErrSnapshotStalled) || string(data) != "partial" || time.Since(start) > 2*time.Second {
		t.Fatalf("stalled body: data=%q err=%v after %s", data, err, time.Since(start))
	}

	rc, err = cl.Snapshot(context.Background(), api.Snapshot{ID: "slow"})
	if err != nil {
		t.Fatal(err)
	}
	data, err = io.ReadAll(rc)
	rc.Close()
	if err != nil || string(data) != "xxxxxxxx" {
		t.Fatalf("a slow but steady download must succeed: %q %v", data, err)
	}
}

func TestVolumeMountsComeFromTheSpecAndAreCached(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	body := `{"spec":{"volumes":[{"name":"uploads","mount":"/data/uploads"},{"name":"nomount","mount":""}]},"deployment":3}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		b := body
		mu.Unlock()
		if r.URL.Path != "/sv/v1/spec" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(b))
	}))
	defer srv.Close()
	cl, _ := New(srv.URL, "tok", false)
	for i := 0; i < 2; i++ {
		mounts, err := cl.VolumeMounts(context.Background())
		if err != nil || len(mounts) != 1 || mounts[0] != "/data/uploads" {
			t.Fatalf("mounts: %v %v", mounts, err)
		}
	}
	mu.Lock()
	n := calls
	mu.Unlock()
	if n != 1 {
		t.Fatalf("expected one cached call, got %d", n)
	}

	// Before the first deploy the CP answers spec:null: no volume is reachable.
	mu.Lock()
	body = `{"spec":null,"deployment":null,"snapshot":null}`
	mu.Unlock()
	fresh, _ := New(srv.URL, "tok", false)
	if mounts, err := fresh.VolumeMounts(context.Background()); err != nil || len(mounts) != 0 {
		t.Fatalf("spec null: %v %v", mounts, err)
	}

	refused, _ := New(srv.URL, "wrong", false)
	var he *HTTPError
	if _, err := refused.VolumeMounts(context.Background()); !errors.As(err, &he) || he.Status != http.StatusUnauthorized {
		t.Fatalf("a refused spec request must be an error: %v", err)
	}
}
