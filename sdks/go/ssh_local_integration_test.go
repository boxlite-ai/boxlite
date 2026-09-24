//go:build boxlite_dev

package boxlite

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSSHLocalLifecycle(t *testing.T) {
	rt := newTestRuntime(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	keys := t.TempDir()
	for _, name := range []string{"host", "user"} {
		if output, err := exec.CommandContext(ctx, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", filepath.Join(keys, name)).CombinedOutput(); err != nil {
			t.Fatalf("keygen: %v %s", err, output)
		}
	}
	host, err := os.ReadFile(filepath.Join(keys, "host"))
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.ReadFile(filepath.Join(keys, "user.pub"))
	if err != nil {
		t.Fatal(err)
	}
	box, err := rt.Create(ctx, "alpine:3.19", WithAutoRemove(false))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if err := rt.ForceRemove(cleanupCtx, box.ID()); err != nil {
			t.Errorf("remove SSH test box: %v", err)
		}
	}()
	defer box.Close()
	ssh, err := box.SSH()
	if err != nil {
		t.Fatal(err)
	}
	defer ssh.Close()
	config := SSHConfig{ListenAddress: "0.0.0.0:2222", HostPrivateKey: string(host), Accounts: []SSHAccount{{Login: "alice", AuthorizedKeys: []string{string(key)}}}}
	status, err := ssh.Status(ctx)
	if err != nil || status.Generation != 0 {
		t.Fatalf("initial: %v %v", status, err)
	}
	status, err = ssh.Configure(ctx, config)
	if err != nil || !status.Enabled {
		t.Fatalf("configure: %v %v", status, err)
	}
	status, err = ssh.Configure(ctx, config)
	if err != nil || status.Generation != 2 {
		t.Fatalf("reconfigure: %v %v", status, err)
	}
	status, err = ssh.Disable(ctx)
	if err != nil || status.Enabled {
		t.Fatalf("disable: %v %v", status, err)
	}
}
