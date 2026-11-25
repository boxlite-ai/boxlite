//go:build linux

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
	"github.com/boxlite/gvproxy-bridge/internal/guardkernel"
)

func TestSlowPrepareDoesNotPauseExistingGuard(t *testing.T) {
	object := os.Getenv("BOXLITE_TEST_BPF_OBJECT")
	if object == "" {
		t.Skip("use make test:platform-guard-bpf on Linux with active BPF LSM")
	}
	bpftool, err := exec.LookPath("bpftool")
	if err != nil {
		t.Fatal(err)
	}
	pins, err := os.MkdirTemp("/sys/fs/bpf", "boxlite_service_test_")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(pins) })
	cgroups, err := os.MkdirTemp("/sys/fs/cgroup", "boxlite_service_test_")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(cgroups) })
	for _, box := range []string{"active", "slow"} {
		directory := filepath.Join(cgroups, box)
		if err := os.Mkdir(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(directory) })
	}

	inventory := t.TempDir()
	empty := []string{}
	data, err := json.Marshal(guardinventory.Document{
		Version: 1, Revision: "test", ExpiresAt: time.Now().Add(time.Minute),
		ProtectedNetworks: guardinventory.Networks{
			Node: empty, ControlPlane: empty, Metadata: empty, Services: empty,
		},
		ResolverEndpoints: []string{"192.0.2.53:53"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inventory, guardinventory.FileName), data, 0o600); err != nil {
		t.Fatal(err)
	}
	m := &manager{
		object: object, pins: pins, cgroups: cgroups, records: t.TempDir(), inventory: inventory,
		active: make(map[string]record), retired: make(map[string]struct{}), preparing: make(map[string]struct{}),
	}
	active, err := m.prepare(t.Context(), "active", "first", filepath.Join(inventory, "active.sock"))
	if err != nil {
		t.Fatal(err)
	}
	initial, err := m.prove(active)
	if err != nil {
		t.Fatal(err)
	}
	process := exec.CommandContext(t.Context(), "/bin/sleep", "10")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = process.Process.Kill()
		_ = process.Wait()
	})
	if err := os.WriteFile(filepath.Join(cgroups, "active", "cgroup.procs"), []byte(strconv.Itoa(process.Process.Pid)), 0o644); err != nil {
		t.Fatal(err)
	}

	tools := t.TempDir()
	release := filepath.Join(tools, "release")
	entered := filepath.Join(tools, "entered")
	const slowLoader = `#!/bin/sh
case "$4" in
    */slow/programs)
        : > "$BOXLITE_TEST_ENTERED"
        while [ ! -f "$BOXLITE_TEST_RELEASE" ]; do sleep 0.02; done
        ;;
esac
exec "$BOXLITE_TEST_BPFTOOL" "$@"
`
	t.Setenv("BOXLITE_TEST_BPFTOOL", bpftool)
	t.Setenv("BOXLITE_TEST_ENTERED", entered)
	t.Setenv("BOXLITE_TEST_RELEASE", release)
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := os.WriteFile(filepath.Join(tools, "bpftool"), []byte(slowLoader), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		m.watch(ctx)
	}()
	t.Cleanup(func() { cancel(); <-watchDone })

	prepared := make(chan error, 1)
	prepareDone := make(chan struct{})
	go func() {
		defer close(prepareDone)
		_, err := m.prepare(ctx, "slow", "second", filepath.Join(inventory, "slow.sock"))
		prepared <- err
	}()
	t.Cleanup(func() {
		_ = os.WriteFile(release, nil, 0o600)
		cancel()
		<-prepareDone
	})
	waitForFile(t, entered)
	// Keep the loader blocked until the established Box's original lease
	// has elapsed. Only the watcher can have extended that lease.
	now, err := guardkernel.NowNS()
	if err != nil {
		t.Fatal(err)
	}
	if now < initial {
		time.Sleep(time.Duration(initial-now) + 50*time.Millisecond)
	}
	deadline, err := m.prove(active)
	if err != nil || deadline <= initial {
		t.Fatalf("active Box did not renew while a different Box loaded: deadline=%d, initial=%d, error=%v", deadline, initial, err)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-prepared:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("second Box did not finish after releasing its loader")
	}
}

func waitForFile(t *testing.T, name string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(name); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("loader did not reach its synchronization point")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
