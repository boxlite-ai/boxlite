// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func resolverServer(t *testing.T, calls *int32, status *int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		if r.Header.Get("Authorization") != "Bearer s3cret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if s := atomic.LoadInt32(status); s != 0 {
			w.WriteHeader(int(s))
			return
		}
		switch r.URL.Query().Get("host") {
		case "crm.acme.com":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"box_id":"box123","port":10001}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCustomHostRoutesToTheBoxPortTheResolverNames(t *testing.T) {
	var calls, status int32
	srv := resolverServer(t, &calls, &status)
	p := &Proxy{customHosts: newCustomHosts(srv.URL, "s3cret")}

	// A tunnel name never asks the resolver.
	port, box, base, err := p.parseHost("3000-AbCdEf123456.proxy.test")
	if err != nil || port != 3000 || box != "AbCdEf123456" || base != "proxy.test" || calls != 0 {
		t.Fatalf("tunnel host: %d %q %q %v (calls %d)", port, box, base, err, calls)
	}

	port, box, _, err = p.parseHost("CRM.acme.com:443")
	if err != nil || port != 10001 || box != "box123" {
		t.Fatalf("custom host: %d %q %v", port, box, err)
	}
	if _, _, _, err = p.parseHost("crm.acme.com"); err != nil || calls != 1 {
		t.Fatalf("second lookup must come from the cache: %v (calls %d)", err, calls)
	}

	if _, _, _, err = p.parseHost("unknown.example.org"); err == nil {
		t.Fatal("an unknown host must stay unroutable")
	}
	p.parseHost("unknown.example.org")
	if calls != 2 {
		t.Fatalf("an unknown host is cached too (calls %d)", calls)
	}
}

func TestCustomHostResolverErrorsAreNotCached(t *testing.T) {
	var calls, status int32
	srv := resolverServer(t, &calls, &status)
	p := &Proxy{customHosts: newCustomHosts(srv.URL, "s3cret")}
	atomic.StoreInt32(&status, http.StatusBadGateway)
	if _, _, _, err := p.parseHost("crm.acme.com"); err == nil {
		t.Fatal("a resolver error must not route")
	}
	atomic.StoreInt32(&status, 0)
	if port, _, _, err := p.parseHost("crm.acme.com"); err != nil || port != 10001 {
		t.Fatalf("after the resolver recovers: %d %v", port, err)
	}
}

func TestWithoutAResolverNothingChanges(t *testing.T) {
	p := &Proxy{}
	if _, _, _, err := p.parseHost("crm.acme.com"); err == nil {
		t.Fatal("without CUSTOM_HOST_RESOLVER_URL a custom host is not routed")
	}
	if newCustomHosts("", "x") != nil {
		t.Fatal("an empty resolver URL must mean no resolver")
	}
}
