//go:build linux

package proc

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// procState returns the state letter from /proc/<pid>/stat, or "" when the
// pid no longer exists (i.e. it has been reaped).
func procState(pid int) string {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return ""
	}
	// "pid (comm) S ..." — comm may contain spaces, so split after the last ')'.
	rest := data[strings.LastIndexByte(string(data), ')')+1:]
	fields := strings.Fields(string(rest))
	if len(fields) == 0 {
		return "?"
	}
	return fields[0]
}

// TestReaperAdoptsDoubleForkedOrphan is the PID 1 scenario: a child forks a
// grandchild and exits; the grandchild is re-parented to us (as subreaper here,
// as PID 1 in the Box) and must be reaped once it exits instead of lingering
// as a zombie.
func TestReaperAdoptsDoubleForkedOrphan(t *testing.T) {
	if err := BecomeSubreaper(); err != nil {
		t.Skipf("prctl(PR_SET_CHILD_SUBREAPER) unavailable: %v", err)
	}
	r := testReaper(t)
	reapedBefore := r.Reaped()

	// No group kill, so the orphan survives its parent.
	cmd := exec.Command("/bin/sh", "-c", "sleep 0.3 & echo $!; exit 0")
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout = pw
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	exitCh, err := r.Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	pw.Close()

	line, err := bufio.NewReader(pr).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	pr.Close()
	orphan, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || orphan <= 0 {
		t.Fatalf("orphan pid: %q %v", line, err)
	}

	select {
	case ws := <-exitCh:
		if ExitCode(ws) != 0 {
			t.Fatalf("parent exit code %d", ExitCode(ws))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("parent was never reaped")
	}

	deadline := time.Now().Add(5 * time.Second)
	for procState(orphan) != "" {
		if time.Now().After(deadline) {
			t.Fatalf("orphan %d still present in state %q (zombie not reaped)", orphan, procState(orphan))
		}
		time.Sleep(50 * time.Millisecond)
	}
	if r.Reaped()-reapedBefore < 2 {
		t.Fatalf("reaped %d processes, want parent and orphan", r.Reaped()-reapedBefore)
	}
}

// TestReaperChildThatExitsImmediately: a child that is gone before Start
// returns still gets its own status, every time. With the old
// Start-then-Subscribe this relied on parking the status for later.
func TestReaperChildThatExitsImmediately(t *testing.T) {
	r := testReaper(t)
	for i := 0; i < 50; i++ {
		exitCh, err := r.Start(exec.Command("/bin/sh", "-c", "exit "+strconv.Itoa(i%7)))
		if err != nil {
			t.Fatal(err)
		}
		select {
		case ws := <-exitCh:
			if got := ExitCode(ws); got != i%7 {
				t.Fatalf("run %d: exit code %d, want %d", i, got, i%7)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("run %d: exit status never delivered", i)
		}
	}
}

// TestReaperNeverHandsAStaleStatusToAReusedPid: the status of a pid nobody
// started through Start (an orphan) must be dropped, not kept for whichever
// process the kernel gives that pid next. A private reaper (never Run, so it
// does not compete with the shared one) is driven directly: an orphan's
// status arrives for pid P, then a new child is "started" with the same pid.
func TestReaperNeverHandsAStaleStatusToAReusedPid(t *testing.T) {
	r := NewReaper()
	const pid = 4242
	orphanStatus := syscall.WaitStatus(3 << 8) // exited with code 3
	r.mu.Lock()
	r.deliverLocked(pid, orphanStatus)
	r.mu.Unlock()

	exitCh, err := r.start(func() (int, error) { return pid, nil })
	if err != nil {
		t.Fatal(err)
	}
	select {
	case ws := <-exitCh:
		t.Fatalf("the reused pid was handed the orphan's status (exit code %d)", ExitCode(ws))
	case <-time.After(100 * time.Millisecond):
	}

	ownStatus := syscall.WaitStatus(0)
	r.mu.Lock()
	r.deliverLocked(pid, ownStatus)
	r.mu.Unlock()
	select {
	case ws := <-exitCh:
		if ExitCode(ws) != 0 {
			t.Fatalf("got exit code %d, want the new child's 0", ExitCode(ws))
		}
	case <-time.After(time.Second):
		t.Fatal("the new child's own status was not delivered")
	}
	if len(r.waiters) != 0 {
		t.Fatalf("waiters left behind: %v", r.waiters)
	}
}
