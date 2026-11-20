//go:build linux

package guardkernel

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPinnedGuardIdentityAndDeadline(t *testing.T) {
	object := os.Getenv("BOXLITE_TEST_BPF_OBJECT")
	if object == "" {
		t.Skip("use make test:platform-guard-bpf on a Linux host with active BPF LSM")
	}
	pinRoot, err := os.MkdirTemp("/sys/fs/bpf", "boxlite_guard_test_")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(pinRoot) })
	group := newTestCgroup(t)
	pins := filepath.Join(pinRoot, "guard")
	original, err := Attach(object, pins, group)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := Inspect(pins, group)
	if err != nil || reopened != original {
		t.Fatalf("reopening pins returned %+v, err=%v, want %+v", reopened, err, original)
	}
	if _, err := Inspect(pins, newTestCgroup(t)); err == nil {
		t.Fatal("the same pins authenticated another cgroup")
	}
	if value, err := CurrentDeadline(pins); err != nil || value != 0 {
		t.Fatalf("newly installed guard opened admission: deadline=%d, error=%v", value, err)
	}
	deadline, err := DeadlineNS(time.Now().Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if err := SetDeadline(pins, deadline); err != nil {
		t.Fatal(err)
	}
	if value, err := CurrentDeadline(pins); err != nil || value == 0 {
		t.Fatalf("deadline was not published: deadline=%d, error=%v", value, err)
	}
	if err := RegisterGuest(pins, 321); err != nil {
		t.Fatal(err)
	}
	if err := RegisterGuest(pins, 321); err != nil {
		t.Fatalf("repeated registration of the same socket was refused: %v", err)
	}
	if err := RegisterGuest(pins, 322); err == nil {
		t.Fatal("replacement socket identity was accepted")
	}
	if err := SetDeadline(pins, 0); err != nil {
		t.Fatal(err)
	}
	if value, err := CurrentDeadline(pins); err != nil || value != 0 {
		t.Fatalf("revocation left an active kernel deadline: deadline=%d, error=%v", value, err)
	}
	if err := os.Remove(filepath.Join(pins, "cloud_send")); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(pins, group); err == nil {
		t.Fatal("a missing socket-send attachment was accepted")
	}
}

func newTestCgroup(t *testing.T) string {
	t.Helper()
	group, err := os.MkdirTemp("/sys/fs/cgroup", "boxlite_guard_test_")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(group) })
	return group
}

func TestKernelRenewalRefusesAnExpiredOrReplacedLease(t *testing.T) {
	object := os.Getenv("BOXLITE_TEST_BPF_OBJECT")
	if object == "" {
		t.Skip("use make test:platform-guard-bpf on a Linux host with active BPF LSM")
	}
	pinRoot, err := os.MkdirTemp("/sys/fs/bpf", "boxlite_renewal_test_")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(pinRoot) })
	group := newTestCgroup(t)
	pins := filepath.Join(pinRoot, "guard")
	if _, err := Attach(object, pins, group); err != nil {
		t.Fatal(err)
	}
	first, err := DeadlineNS(time.Now().Add(300 * time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	next := first + uint64(time.Second)
	if err := SetDeadline(pins, first); err != nil {
		t.Fatal(err)
	}
	if accepted, err := RenewDeadline(pins, first, next); err != nil || !accepted {
		t.Fatalf("valid renewal was refused: accepted=%t, error=%v", accepted, err)
	}
	if err := SetDeadline(pins, first); err != nil {
		t.Fatal(err)
	}
	time.Sleep(350 * time.Millisecond)
	if accepted, err := RenewDeadline(pins, first, next); err != nil || accepted {
		t.Fatalf("publication delayed past deadline reactivated the lease: accepted=%t, error=%v", accepted, err)
	}
	if value, err := CurrentDeadline(pins); err != nil || value > first {
		t.Fatalf("late publication changed the cutoff: value=%d, error=%v", value, err)
	}
	if err := SetDeadline(pins, 0); err != nil {
		t.Fatal(err)
	}
	if accepted, err := RenewDeadline(pins, 0, next); err != nil || accepted {
		t.Fatalf("a revoked lease was reopened: accepted=%t, error=%v", accepted, err)
	}
	fresh, err := DeadlineNS(time.Now().Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if err := SetDeadline(pins, fresh); err != nil {
		t.Fatal(err)
	}
	if accepted, err := RenewDeadline(pins, fresh-1, fresh+1); err != nil || accepted {
		t.Fatalf("renewal using a replaced deadline: accepted=%t, error=%v", accepted, err)
	}
}
