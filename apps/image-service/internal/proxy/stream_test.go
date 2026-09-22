// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"
)

// A blob is the largest thing this proxy touches and it is measured in
// gigabytes. Reading one in before answering would put a whole image layer in
// this process's memory, so what is asserted is that the caller has bytes
// before the upstream has finished sending them — the observable difference
// between streaming and buffering, with no memory measurement to be flaky about.
func TestBlobBytesReachTheCallerBeforeTheUpstreamHasFinished(t *testing.T) {
	upstream := newStubUpstream(t)
	upstream.blob = make([]byte, blobFirstChunk+4096)
	for i := range upstream.blob {
		upstream.blob[i] = byte(i)
	}
	upstream.blobBarrier = make(chan struct{})

	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	server := httptest.NewServer(router)
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet,
		server.URL+"/v2/acme/ghcr.io/acme/app/blobs/"+digestOf(upstream.blob), nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.SetBasicAuth("runner", runnerKey)

	// A deadline, so a proxy that buffers reports itself as a failed assertion
	// rather than as a suite that hangs: the response headers are what it would
	// be withholding, and they arrive before any select below can run.
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		close(upstream.blobBarrier)
		t.Fatalf("no response while the upstream was still sending, so the blob is being buffered: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET blob = %d", response.StatusCode)
	}

	// The upstream is still holding the rest of the blob. If the proxy buffered,
	// this read cannot complete and the timeout below is what reports it.
	firstByte := make(chan error, 1)
	head := make([]byte, blobFirstChunk)
	go func() {
		_, err := io.ReadFull(response.Body, head)
		firstByte <- err
	}()

	select {
	case err := <-firstByte:
		if err != nil {
			t.Fatalf("reading the first byte: %v", err)
		}
	case <-time.After(3 * time.Second):
		close(upstream.blobBarrier)
		t.Fatal("no bytes reached the caller while the upstream was still sending: the blob is being buffered")
	}
	if string(head) != string(upstream.blob[:blobFirstChunk]) {
		t.Error("the bytes that arrived early are not the ones the upstream sent first")
	}

	close(upstream.blobBarrier)
	rest, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("reading the rest: %v", err)
	}
	if got := string(head) + string(rest); got != string(upstream.blob) {
		t.Errorf("relayed blob = %q, want %q", got, string(upstream.blob))
	}
}

// The same claim measured rather than observed: relaying a blob must not
// allocate on the order of the blob. Buffering 64 MiB cannot be done without
// allocating at least 64 MiB, so the cumulative counter separates the two
// without having to catch a peak.
//
// The budget is not close to either side. Streaming this blob allocates around
// 450 KiB; buffering it allocated 165 MiB when that was tried deliberately. The
// counter is process-wide, so the in-process stub spends against it too — which
// is why the budget sits about 36 times above what was measured, and
// why this test must not be made parallel: a concurrent test would spend
// against the same counter.
func TestRelayingALargeBlobDoesNotAllocateOnTheOrderOfTheBlob(t *testing.T) {
	const blobSize = 64 << 20

	upstream := newStubUpstream(t)
	upstream.blob = make([]byte, blobSize)
	router, _ := testProxy(t, upstream, runnerPlane(t), "ghcr.io")
	server := httptest.NewServer(router)
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet,
		server.URL+"/v2/acme/ghcr.io/acme/app/blobs/sha256:ab12cd34", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.SetBasicAuth("runner", runnerKey)

	// Warm the credential cache and the connection so the measurement covers
	// the relay rather than the first-request machinery.
	if warmup := pull(router, http.MethodGet, ghcrPath, runnerKey); warmup.Code != http.StatusOK {
		t.Fatalf("warm-up pull = %d", warmup.Code)
	}

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("GET blob: %v", err)
	}
	relayed, err := io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatalf("reading the blob: %v", err)
	}
	if relayed != blobSize {
		t.Fatalf("relayed %d bytes, want %d", relayed, blobSize)
	}

	runtime.ReadMemStats(&after)
	allocated := after.TotalAlloc - before.TotalAlloc
	// A quarter of the blob: far above what copying through a fixed buffer
	// costs, far below what holding the blob would.
	t.Logf("relaying %d bytes allocated %d", blobSize, allocated)
	if limit := uint64(blobSize / 4); allocated > limit {
		t.Errorf("relaying %d bytes allocated %d, want under %d", blobSize, allocated, limit)
	}
}
