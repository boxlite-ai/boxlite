// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

/*
What the ID token transport has to get right.

The failure it exists to prevent is silent: a client on Cloud Run's invoker list
that sends no token is answered 403 by Google's front end, and the only symptom
is telemetry that never arrives. So what is checked here is the header actually
being attached, the token being reused rather than re-fetched per span, and a
near-expiry token being replaced before it stops working — the last one being
the difference between a fix and an outage that returns in an hour.
*/

package telemetry

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

/** A JWT with the given expiry. Unsigned: nothing here verifies signatures. */
func jwtExpiring(at time.Time) string {
	payload, _ := json.Marshal(map[string]int64{"exp": at.Unix()})
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

/** A transport that records what it was handed, standing in for the network. */
type recordingTransport struct {
	seen []*http.Request
}

func (r *recordingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	r.seen = append(r.seen, request)
	return &http.Response{StatusCode: 200, Body: http.NoBody, Header: http.Header{}}, nil
}

func TestAttachesBearerTokenAndReusesIt(t *testing.T) {
	fetches := 0
	recorder := &recordingTransport{}
	transport := &googleIDTokenTransport{
		audience: "https://collector.example",
		base:     recorder,
		fetch: func(string) (string, error) {
			fetches++
			return jwtExpiring(time.Now().Add(time.Hour)), nil
		},
	}

	for range 3 {
		request, _ := http.NewRequest(http.MethodPost, "https://collector.example/v1/traces", nil)
		if _, err := transport.RoundTrip(request); err != nil {
			t.Fatalf("RoundTrip: %v", err)
		}
	}

	if fetches != 1 {
		t.Errorf("fetched the token %d times; a token good for an hour is fetched once, not per export", fetches)
	}
	if len(recorder.seen) != 3 {
		t.Fatalf("passed %d requests through, want 3", len(recorder.seen))
	}
	for i, request := range recorder.seen {
		if got := request.Header.Get("Authorization"); !strings.HasPrefix(got, "Bearer ") {
			t.Errorf("request %d carried Authorization %q; without it Cloud Run answers 403", i, got)
		}
	}
}

func TestRefreshesBeforeExpiry(t *testing.T) {
	// The whole point of a token source over a static header: one that expires
	// mid-flight turns a permanent 403 into one that comes back in an hour.
	fetches := 0
	transport := &googleIDTokenTransport{
		audience: "https://collector.example",
		base:     &recordingTransport{},
		fetch: func(string) (string, error) {
			fetches++
			// Inside the refresh margin, so it is never reusable.
			return jwtExpiring(time.Now().Add(idTokenRefreshMargin / 2)), nil
		},
	}

	for range 2 {
		request, _ := http.NewRequest(http.MethodPost, "https://collector.example/v1/traces", nil)
		if _, err := transport.RoundTrip(request); err != nil {
			t.Fatalf("RoundTrip: %v", err)
		}
	}
	if fetches != 2 {
		t.Errorf("fetched %d times; a token inside the refresh margin must be replaced, not reused", fetches)
	}
}

func TestDoesNotSendAnythingWhenTheTokenCannotBeObtained(t *testing.T) {
	// Failing closed: an unauthenticated export would be refused anyway, and an
	// error naming the token is the one a person can act on.
	recorder := &recordingTransport{}
	transport := &googleIDTokenTransport{
		audience: "https://collector.example",
		base:     recorder,
		fetch:    func(string) (string, error) { return "", fmt.Errorf("metadata server answered 404") },
	}

	request, _ := http.NewRequest(http.MethodPost, "https://collector.example/v1/traces", nil)
	if _, err := transport.RoundTrip(request); err == nil {
		t.Fatal("RoundTrip succeeded without a token; it must fail rather than export unauthenticated")
	}
	if len(recorder.seen) != 0 {
		t.Errorf("sent %d requests without a token", len(recorder.seen))
	}
}

func TestDoesNotMutateTheRequestItWasGiven(t *testing.T) {
	// The exporter retries the same request; a RoundTripper that stamped a
	// header onto it would leave a stale token on the retry.
	transport := &googleIDTokenTransport{
		audience: "https://collector.example",
		base:     &recordingTransport{},
		fetch:    func(string) (string, error) { return jwtExpiring(time.Now().Add(time.Hour)), nil },
	}
	request, _ := http.NewRequest(http.MethodPost, "https://collector.example/v1/traces", nil)
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	if got := request.Header.Get("Authorization"); got != "" {
		t.Errorf("the caller's request was modified: Authorization=%q", got)
	}
}

func TestFetchReadsAWholeTokenAndRequiresTheMetadataHeader(t *testing.T) {
	// The reproducer for a truncation bug: reading into a fixed buffer with one
	// `Read` can return fewer bytes than are waiting, and a JWT cut mid-segment
	// is refused with the same 403 as no token at all. The answer below arrives
	// in two flushed chunks, which is what makes a single `Read` partial.
	long := jwtExpiring(time.Now().Add(time.Hour)) + strings.Repeat("A", 8192)
	var sawHeader, sawAudience string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		sawHeader = request.Header.Get("Metadata-Flavor")
		sawAudience = request.URL.Query().Get("audience")
		if sawHeader != "Google" {
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		for _, chunk := range []string{long[:10], long[10:]} {
			io.WriteString(writer, chunk)
			writer.(http.Flusher).Flush()
		}
	}))
	defer server.Close()

	original := metadataIdentityURL
	metadataIdentityURL = server.URL
	defer func() { metadataIdentityURL = original }()

	got, err := fetchMetadataIDToken("https://collector.example")
	if err != nil {
		t.Fatalf("fetchMetadataIDToken: %v", err)
	}
	if got != long {
		t.Errorf("read %d bytes of a %d-byte token; a truncated JWT is refused exactly like a missing one", len(got), len(long))
	}
	if sawHeader != "Google" {
		t.Errorf("Metadata-Flavor was %q; the metadata server refuses a request without it", sawHeader)
	}
	if sawAudience != "https://collector.example" {
		t.Errorf("audience was %q; Cloud Run checks aud against its own address", sawAudience)
	}
}

func TestFetchTreatsANonOKAnswerAsAFailureAndDoesNotEchoIt(t *testing.T) {
	// On the success path these bytes are a credential, so an error must not
	// quote the body it read.
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
		io.WriteString(writer, "secret-looking-body")
	}))
	defer server.Close()

	original := metadataIdentityURL
	metadataIdentityURL = server.URL
	defer func() { metadataIdentityURL = original }()

	_, err := fetchMetadataIDToken("https://collector.example")
	if err == nil {
		t.Fatal("a 404 was accepted as a token")
	}
	if strings.Contains(err.Error(), "secret-looking-body") {
		t.Errorf("the error echoed the body: %v", err)
	}
}

func TestExpiryComesFromTheTokenItself(t *testing.T) {
	at := time.Now().Add(42 * time.Minute).Truncate(time.Second)
	got, err := idTokenExpiry(jwtExpiring(at))
	if err != nil {
		t.Fatalf("idTokenExpiry: %v", err)
	}
	if !got.Equal(at) {
		t.Errorf("expiry %v, want %v", got, at)
	}
	for _, malformed := range []string{"", "not-a-jwt", "a.b", "a.!!!.c"} {
		if _, err := idTokenExpiry(malformed); err == nil {
			t.Errorf("%q was accepted as a JWT", malformed)
		}
	}
}

func TestAnUnreadableExpiryIsNotCachedForever(t *testing.T) {
	// A token whose expiry cannot be read is still usable, but caching it would
	// pin one token past the point Google stops accepting it.
	fetches := 0
	transport := &googleIDTokenTransport{
		audience: "https://collector.example",
		base:     &recordingTransport{},
		fetch: func(string) (string, error) {
			fetches++
			return "opaque-not-a-jwt", nil
		},
	}
	for range 2 {
		request, _ := http.NewRequest(http.MethodPost, "https://collector.example/v1/traces", nil)
		if _, err := transport.RoundTrip(request); err != nil {
			t.Fatalf("RoundTrip: %v", err)
		}
	}
	if fetches != 2 {
		t.Errorf("fetched %d times; a token with no readable expiry must be re-fetched", fetches)
	}
}
