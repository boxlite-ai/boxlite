//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Local VM journeys for guest SSH: observing never boots a box, every
// accepted configure restarts the listener, disable is idempotent, and a box
// with an explicit main command must be started before configure.

// sshKeyPair generates a disposable ed25519 key and returns its private and
// public halves.
func sshKeyPair(t *testing.T, name string) (private, public string) {
	t.Helper()
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen not available")
	}
	path := filepath.Join(t.TempDir(), name)
	out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-C", "go-ssh-test", "-f", path).CombinedOutput()
	if err != nil {
		t.Fatalf("ssh-keygen: %v: %s", err, out)
	}
	privateKey, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := os.ReadFile(path + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	return string(privateKey), string(publicKey)
}

func vmSSHConfig(t *testing.T) SSHConfig {
	t.Helper()
	host, _ := sshKeyPair(t, "host")
	_, user := sshKeyPair(t, "user")
	return SSHConfig{
		ListenAddress:  "0.0.0.0:2222",
		HostPrivateKey: host,
		Accounts:       []SSHAccount{{Login: "alice", AuthorizedKeys: []string{user}}},
	}
}

// createSSHBox creates an unstarted box, skipping on missing infrastructure.
func createSSHBox(t *testing.T, rt *Runtime, opts ...BoxOption) *Box {
	t.Helper()
	ctx := context.Background()
	box, err := rt.Create(ctx, "alpine:latest", append([]BoxOption{WithAutoRemove(false)}, opts...)...)
	if err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrStorage || e.Code == ErrImage || e.Code == ErrNetwork) {
			t.Skipf("infrastructure prerequisite unavailable (code=%d): %v", e.Code, err)
		}
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() {
		_ = box.Stop(ctx)
		_ = rt.ForceRemove(ctx, box.ID())
		_ = box.Close()
	})
	return box
}

func requireSSHDisabled(t *testing.T, status *SSHStatus, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("SSH call: %v", err)
	}
	if *status != (SSHStatus{}) {
		t.Fatalf("got %+v, want disabled status with generation zero", status)
	}
}

func requireNotRunning(t *testing.T, box *Box) {
	t.Helper()
	info, err := box.Info(context.Background())
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.Running {
		t.Fatalf("box is running in state %q", info.State)
	}
}

func TestIntegrationSSHConfigureReconfigureAndDisable(t *testing.T) {
	ctx := context.Background()
	rt := newTestRuntime(t)
	box := createSSHBox(t, rt)
	ssh := box.SSH()

	// Observing SSH must not boot the box.
	status, err := ssh.Status(ctx)
	requireSSHDisabled(t, status, err)
	status, err = ssh.Disable(ctx)
	requireSSHDisabled(t, status, err)
	requireNotRunning(t, box)

	config := vmSSHConfig(t)
	first, err := ssh.Configure(ctx, config)
	if err != nil {
		t.Fatalf("Configure: %v", err)
	}
	if !first.Enabled || first.Generation == 0 || first.ListenAddress == "" ||
		first.HostPublicKey == "" || first.HostKeyFingerprint == "" {
		t.Fatalf("first configure: got %+v", first)
	}

	// Every accepted configure restarts SSH; the host key stays the same.
	second, err := ssh.Configure(ctx, config)
	if err != nil {
		t.Fatalf("reconfigure: %v", err)
	}
	if second.Generation <= first.Generation || second.HostKeyFingerprint != first.HostKeyFingerprint {
		t.Fatalf("reconfigure: got %+v after %+v", second, first)
	}

	// A rejected key leaves the listener alone and is not echoed.
	rejected := config
	rejected.HostPrivateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nLEAKCHECK-not-a-key\n"
	_, err = ssh.Configure(ctx, rejected)
	requireErrorCode(t, err, ErrInvalidArgument, "")
	if strings.Contains(err.Error(), "LEAKCHECK") {
		t.Fatalf("error exposes the submitted key: %v", err)
	}
	if intact, err := ssh.Status(ctx); err != nil || *intact != *second {
		t.Fatalf("status after rejection: got (%+v, %v), want %+v", intact, err, second)
	}

	// Disable is idempotent and keeps the generation.
	for range 2 {
		disabled, err := ssh.Disable(ctx)
		if err != nil {
			t.Fatalf("Disable: %v", err)
		}
		if disabled.Enabled || disabled.Generation != second.Generation {
			t.Fatalf("Disable: got %+v, want disabled at generation %d", disabled, second.Generation)
		}
	}
	if status, err := ssh.Status(ctx); err != nil || status.Enabled {
		t.Fatalf("status after disable: got (%+v, %v)", status, err)
	}
}

func TestIntegrationSSHExplicitCommandRequiresStart(t *testing.T) {
	ctx := context.Background()
	rt := newTestRuntime(t)
	box := createSSHBox(t, rt, WithCmd("sleep", "infinity"))
	config := vmSSHConfig(t)

	_, err := box.SSH().Configure(ctx, config)
	requireErrorCode(t, err, ErrInvalidState, "")
	status, err := box.SSH().Status(ctx)
	requireSSHDisabled(t, status, err)
	requireNotRunning(t, box)

	if err := box.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	running, err := box.SSH().Configure(ctx, config)
	if err != nil || !running.Enabled {
		t.Fatalf("Configure after Start: got (%+v, %v)", running, err)
	}
	if err := box.Stop(ctx); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	// The stopped handle is spent; a fresh one observes without starting.
	fresh, err := rt.Get(ctx, box.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer fresh.Close()
	_, err = fresh.SSH().Configure(ctx, config)
	requireErrorCode(t, err, ErrInvalidState, "")
	status, err = fresh.SSH().Status(ctx)
	requireSSHDisabled(t, status, err)
	status, err = fresh.SSH().Disable(ctx)
	requireSSHDisabled(t, status, err)
	requireNotRunning(t, fresh)
}
