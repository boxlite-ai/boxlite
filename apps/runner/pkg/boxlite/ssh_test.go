//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

const sshGuestPort = 2222

// newSSHTestBox creates a box through the runner client and waits for want.
// An empty entrypoint keeps the image's default command. Networking stays on:
// guest tunnels need it.
func newSSHTestBox(t *testing.T, id string, entrypoint string, want enums.BoxState) (*Client, string) {
	t.Helper()
	ctx := context.Background()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		skipOrFailRuntimeStart(t, err)
	}
	t.Cleanup(func() { _ = client.Close() })
	networked := true
	createDto := dto.CreateBoxDTO{
		Id:              id,
		Image:           "alpine:latest",
		OsUser:          "root",
		CpuQuota:        1,
		MemoryQuota:     1,
		StorageQuota:    1,
		OutboundEnabled: &networked,
	}
	if entrypoint != "" {
		createDto.Entrypoint = []string{"/bin/sh", "-c", entrypoint}
	}
	if _, _, err := client.Create(ctx, createDto); err != nil {
		// Only an image pull is outside this test's control.
		var runtimeErr *boxlite.Error
		if errors.As(err, &runtimeErr) && runtimeErr.Code == boxlite.ErrImage {
			t.Skipf("image pull failed (infrastructure prerequisite): %v", err)
		}
		t.Fatalf("Create: %v", err)
	}
	waitForBoxState(ctx, t, client, id, want)
	return client, id
}

func requireStillStopped(t *testing.T, client *Client, boxID string) {
	t.Helper()
	// A boot takes about a second; give one time to show up.
	time.Sleep(3 * time.Second)
	info, err := client.GetBoxInfo(context.Background(), boxID)
	if err != nil {
		t.Fatalf("GetBoxInfo: %v", err)
	}
	if info.BoxState != enums.BoxStateStopped {
		t.Fatalf("box state = %s, want %s (an SSH call booted the box)", info.BoxState, enums.BoxStateStopped)
	}
}

// Status and disable on a stopped box answer the complete disabled status from
// persisted state: no boot, and no handle fetched (each fetch for a down box
// evicts and leaks one). Configure refuses instead of booting it, even on the
// image's default command, which the SDK would start through a fresh handle.
func TestIntegrationSSHOnStoppedBoxNeverStartsIt(t *testing.T) {
	client, boxID := newSSHTestBox(t, "ssh-stopped-box", "", enums.BoxStateStarted)
	ctx := context.Background()
	// The control plane's stop, as the AutoStop sweeper sends it.
	if err := client.Stop(ctx, boxID, false); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	waitForBoxState(ctx, t, client, boxID, enums.BoxStateStopped)

	for name, call := range map[string]func(context.Context, string) (*boxlite.SSHStatus, error){
		"status": client.SSHStatus, "disable": client.SSHDisable,
	} {
		status, err := call(ctx, boxID)
		if err != nil {
			t.Fatalf("%s on a stopped box: %v", name, err)
		}
		if *status != (boxlite.SSHStatus{}) {
			t.Fatalf("%s on a stopped box = %+v, want the zero disabled status", name, *status)
		}
	}
	if _, err := client.SSHConfigure(ctx, boxID, boxlite.SSHConfig{}); !errors.Is(err, ErrBoxNotRunning) {
		t.Fatalf("configure on a stopped box: err = %v, want ErrBoxNotRunning", err)
	}

	client.mu.RLock()
	_, fetched := client.boxes[boxID]
	client.mu.RUnlock()
	if fetched {
		t.Fatal("an SSH call on a stopped box fetched a handle for it")
	}
	requireStillStopped(t, client, boxID)
}

// A stop landing between configure's state check and its handle must not let
// the handle boot the box again.
func TestIntegrationSSHConfigureDoesNotBootABoxStoppedAfterTheCheck(t *testing.T) {
	client, boxID := newSSHTestBox(t, "ssh-stop-race-box", "sleep 600", enums.BoxStateStarted)
	ctx := context.Background()
	client.afterGuestStateCheck = func(boxID string) {
		if err := client.Stop(ctx, boxID, false); err != nil {
			t.Errorf("Stop: %v", err)
		}
	}

	if _, err := client.SSHConfigure(ctx, boxID, boxlite.SSHConfig{}); !errors.Is(err, ErrBoxNotRunning) {
		t.Fatalf("configure on a box stopped after its check: err = %v, want ErrBoxNotRunning", err)
	}
	requireStillStopped(t, client, boxID)
}

// The OpenSSH client, reaching the guest through DialGuestPort, runs a
// command; a key the account does not list is refused; and every accepted
// configure (one listener restart each) and disable end the open session.
func TestIntegrationSSHServesTheRealClient(t *testing.T) {
	client, boxID := newSSHTestBox(t, "ssh-real-client-box", "sleep 600", enums.BoxStateStarted)
	// Every OpenSSH process runs under this deadline, so a hung login or
	// session ends the test instead of stalling it.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	keys := newSSHTestKeys(t)
	config := boxlite.SSHConfig{
		ListenAddress:  fmt.Sprintf("0.0.0.0:%d", sshGuestPort),
		HostPrivateKey: keys.read(t, "host"),
		Accounts:       []boxlite.SSHAccount{{Login: "alice", AuthorizedKeys: []string{keys.read(t, "alice.pub")}}},
	}

	status, err := client.SSHConfigure(ctx, boxID, config)
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	if !status.Enabled || status.Generation != 1 || status.ListenAddress == "" ||
		status.HostPublicKey == "" || !strings.HasPrefix(status.HostKeyFingerprint, "SHA256:") {
		t.Fatalf("configure status = %+v, want an enabled generation-1 listener with its host identity", *status)
	}
	port := forwardGuestPort(t, client, boxID)
	keys.trustHost(t, port, status.HostPublicKey)

	out, err := keys.ssh(ctx, port, "alice", "echo ssh-over-runner").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "ssh-over-runner" {
		t.Fatalf("ssh command: err = %v, output %q", err, out)
	}
	if out, err := keys.ssh(ctx, port, "mallory", "true").CombinedOutput(); err == nil {
		t.Fatalf("ssh with a key no account lists succeeded: %q", out)
	}

	session := keys.openSession(ctx, t, port)
	status, err = client.SSHConfigure(ctx, boxID, config)
	if err != nil {
		t.Fatalf("reconfigure: %v", err)
	}
	if status.Generation != 2 {
		t.Fatalf("generation after one more configure = %d, want 2 (configure ran other than once)", status.Generation)
	}
	session.requireClosed(t, "reconfigure")

	session = keys.openSession(ctx, t, port)
	status, err = client.SSHDisable(ctx, boxID)
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if status.Enabled || status.Generation != 2 || status.ListenAddress != "" || status.HostPublicKey != "" {
		t.Fatalf("disable status = %+v, want disabled with generation 2 kept", *status)
	}
	session.requireClosed(t, "disable")
}

// sshTestKeys holds disposable keys: "host" for the guest, "alice" for the
// configured account, and "mallory", which no account lists.
type sshTestKeys struct {
	dir string
}

func newSSHTestKeys(t *testing.T) sshTestKeys {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"host", "alice", "mallory"} {
		out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", filepath.Join(dir, name)).CombinedOutput()
		if err != nil {
			t.Skipf("ssh-keygen unavailable (test prerequisite): %v: %s", err, out)
		}
	}
	return sshTestKeys{dir: dir}
}

func (k sshTestKeys) read(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(k.dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// trustHost pins the guest's host key, so a client reaching another server fails.
func (k sshTestKeys) trustHost(t *testing.T, port int, hostPublicKey string) {
	t.Helper()
	line := fmt.Sprintf("[127.0.0.1]:%d %s\n", port, hostPublicKey)
	if err := os.WriteFile(filepath.Join(k.dir, "known_hosts"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (k sshTestKeys) ssh(ctx context.Context, port int, identity string, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "ssh", "-F", "none", "-p", strconv.Itoa(port),
		"-i", filepath.Join(k.dir, identity), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile="+filepath.Join(k.dir, "known_hosts"),
		"-o", "ConnectTimeout=10", "-l", "alice", "127.0.0.1", command)
}

type sshSession struct {
	exited chan struct{} // closed once the ssh process is reaped
}

// openSession starts a long command over SSH and waits until it is running.
// The process is killed and reaped at cleanup; ctx bounds the readiness wait.
func (k sshTestKeys) openSession(ctx context.Context, t *testing.T, port int) sshSession {
	t.Helper()
	cmd := k.ssh(ctx, port, "alice", "echo ready; sleep 300")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make([]byte, len("ready\n"))
	_, readErr := io.ReadFull(stdout, ready)
	session := sshSession{exited: make(chan struct{})}
	go func() {
		_, _ = io.Copy(io.Discard, stdout)
		_ = cmd.Wait()
		close(session.exited)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-session.exited
	})
	if readErr != nil || string(ready) != "ready\n" {
		t.Fatalf("ssh session never started: %v %q", readErr, ready)
	}
	return session
}

func (s sshSession) requireClosed(t *testing.T, cause string) {
	t.Helper()
	select {
	case <-s.exited:
	case <-time.After(30 * time.Second):
		t.Fatalf("an open SSH session survived %s", cause)
	}
}

// forwardGuestPort serves 127.0.0.1:<random> on the host, dialing the guest
// SSH port through DialGuestPort for every connection, as the tunnel route does.
func forwardGuestPort(t *testing.T, client *Client, boxID string) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			local, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer local.Close()
				guest, err := client.DialGuestPort(context.Background(), boxID, sshGuestPort)
				if err != nil {
					t.Logf("dial guest SSH port: %v", err)
					return
				}
				defer guest.Close()
				go func() { _, _ = io.Copy(guest, local) }()
				_, _ = io.Copy(local, guest)
			}()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}
