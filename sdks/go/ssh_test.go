package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSSHRESTAndCancellation(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
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
