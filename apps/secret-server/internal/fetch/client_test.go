package fetch

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientRejectsInvalidResponses(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"active":null}`, `{"active":"true"}`, `{"active":true}`, `{"active":false} {}`, strings.Repeat(" ", 65537)} {
		t.Run(body[:min(len(body), 30)], func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, body) }))
			defer s.Close()
			c, _ := newClient(s.URL)
			if _, err := c.consume(context.Background(), "x", "r"); err == nil {
				t.Fatal("invalid reply accepted")
			}
		})
	}
	for _, mutate := range []func(*authorization){func(a *authorization) { a.CredentialID = "bad" }, func(a *authorization) { a.OrganizationID = "bad" }, func(a *authorization) { a.ExpiresAt = time.Now().Add(-time.Second) }, func(a *authorization) { a.Grants = nil }, func(a *authorization) { a.Grants = []grant{{first}, {first}} }, func(a *authorization) { a.Grants = []grant{{"bad"}} }, func(a *authorization) { a.Grants = make([]grant, 65) }, func(a *authorization) { a.BoxID = "" }} {
		a := active()
		mutate(&a)
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(a) }))
		c, _ := newClient(s.URL)
		_, err := c.consume(context.Background(), "x", "r")
		s.Close()
		if err == nil {
			t.Fatal("invalid active reply accepted")
		}
	}
}
func TestClientNoRetriesRedirectsAndTimeout(t *testing.T) {
	for _, status := range []int{500, 301, 302, 307, 308} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Location", "/redirect")
				w.WriteHeader(status)
			}))
			defer s.Close()
			c, _ := newClient(s.URL)
			if _, err := c.consume(context.Background(), "x", "r"); err == nil || calls != 1 {
				t.Fatalf("calls %d error %v", calls, err)
			}
		})
	}
	var calls atomic.Int32
	release := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); <-release }))
	defer func() { close(release); s.Close() }()
	c, _ := newClient(s.URL)
	if c.http.Timeout != 3*time.Second {
		t.Fatal("wrong timeout")
	}
	c.http.Timeout = 20 * time.Millisecond
	if _, err := c.consume(context.Background(), "x", "r"); err == nil || calls.Load() != 1 {
		t.Fatalf("timeout calls %d, err %v", calls.Load(), err)
	}
}
func TestEndpointValidation(t *testing.T) {
	for _, endpoint := range []string{"", ":bad", "file:///x", "http://user:pass@host", "https://host/?token=x", "https://host/#fragment"} {
		if _, err := newClient(endpoint); err == nil {
			t.Fatal("accepted", endpoint)
		}
	}
}

func TestResponseSizeBoundary(t *testing.T) {
	for _, size := range []int{65536, 65537} {
		body := `{"active":false}`
		body += strings.Repeat(" ", size-len(body))
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, body) }))
		c, _ := newClient(s.URL)
		_, err := c.consume(context.Background(), "x", "r")
		s.Close()
		if (err == nil) != (size == 65536) {
			t.Fatalf("size %d error %v", size, err)
		}
	}
}
