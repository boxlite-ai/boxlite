package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSSHRESTAndCancellation(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var reject atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if reject.Load() {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"code":"invalid_argument","message":"sentinel-private"}}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/ssh/configure") {
			var config SSHConfig
			if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
				t.Error(err)
			}
			if len(config.Accounts) != 1 || config.Accounts[0].CA.Principal != "alice" {
				t.Error("nested credentials lost")
			}
		} else if strings.HasSuffix(r.URL.Path, "/ssh/disable") {
			close(entered)
			<-release
		} else if !strings.HasSuffix(r.URL.Path, "/ssh") {
			fmt.Fprint(w, `{"box_id":"ssh-test","name":null,"status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","pid":null,"image":"alpine","cpus":1,"memory_mib":512}`)
			return
		}
		fmt.Fprint(w, `{"enabled":true,"generation":18446744073709551615,"listen_address":"addr","host_public_key":"key","host_key_fingerprint":"fp"}`)
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	box, err := rt.Get(ctx, "ssh-test")
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	ssh, err := box.SSH()
	if err != nil {
		t.Fatal(err)
	}
	defer ssh.Close()
	status, err := ssh.Configure(ctx, SSHConfig{ListenAddress: "addr", HostPrivateKey: "sentinel", Accounts: []SSHAccount{{Login: "alice", CA: &SSHCAConfig{PublicKey: "key", Principal: "alice"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if status.Generation != ^uint64(0) {
		t.Fatal("generation truncated")
	}
	status, err = ssh.Status(ctx)
	if err != nil || status.HostKeyFingerprint != "fp" {
		t.Fatalf("status: %v %v", status, err)
	}
	cancelled, stop := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() { _, err := ssh.Disable(cancelled); result <- err }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	stop()
	if err := <-result; err != context.Canceled {
		t.Fatalf("cancel: %v", err)
	}
	close(release)
	// A later operation still works while the canceled callback drains.
	if _, err := ssh.Status(ctx); err != nil {
		t.Fatal(err)
	}
	reject.Store(true)
	if _, err := ssh.Status(ctx); err == nil {
		t.Fatal("REST error was swallowed")
	} else {
		var runtimeError *Error
		if !errors.As(err, &runtimeError) || runtimeError.Code != ErrInvalidArgument || strings.Contains(err.Error(), "sentinel") {
			t.Fatalf("error mapping: %v", err)
		}
	}
	if err := ssh.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := ssh.Status(ctx); err != ErrRuntimeClosed {
		t.Fatalf("closed handle: %v", err)
	}
}

func TestSSHDebugRedacts(t *testing.T) {
	config := SSHConfig{HostPrivateKey: "sentinel", Accounts: []SSHAccount{{Login: "alice", AuthorizedKeys: []string{"sentinel"}}}}
	for _, format := range []string{"%v", "%+v", "%#v"} {
		if strings.Contains(fmt.Sprintf(format, config), "sentinel") {
			t.Fatal("credentials exposed")
		}
	}
}

func TestSSHClosedAndCancelledBoundaries(t *testing.T) {
	ctx := context.Background()
	for _, ssh := range []*SSH{nil, {}} {
		if err := ssh.Close(); err != nil {
			t.Fatal(err)
		}
		for _, call := range []func(context.Context) (*SSHStatus, error){ssh.Status, ssh.Disable, func(ctx context.Context) (*SSHStatus, error) { return ssh.Configure(ctx, SSHConfig{}) }} {
			if _, err := call(ctx); err != ErrRuntimeClosed {
				t.Fatalf("closed: %v", err)
			}
		}
	}
	var box *Box
	if _, err := box.SSH(); err != ErrRuntimeClosed {
		t.Fatalf("nil box: %v", err)
	}
	if _, err := (&Box{}).SSH(); err != ErrRuntimeClosed {
		t.Fatalf("closed box: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := (&SSH{}).Status(cancelled); err != context.Canceled {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestSSHRuntimeCloseWakesDelayedOperation(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/ssh") {
			close(entered)
			<-release
			fmt.Fprint(w, `{"enabled":false,"generation":0,"listen_address":"","host_public_key":"","host_key_fingerprint":""}`)
			return
		}
		fmt.Fprint(w, `{"box_id":"ssh-test","name":null,"status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":512}`)
	}))
	defer server.Close()
	defer close(release)
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	box, err := rt.Get(ctx, "ssh-test")
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	ssh, err := box.SSH()
	if err != nil {
		t.Fatal(err)
	}
	defer ssh.Close()
	result := make(chan error, 1)
	go func() { _, err := ssh.Status(ctx); result <- err }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != ErrRuntimeClosed {
			t.Fatalf("in-flight operation: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("runtime close did not wake operation")
	}
	if _, err := ssh.Disable(ctx); err != ErrRuntimeClosed {
		t.Fatalf("closed runtime: %v", err)
	}
}
