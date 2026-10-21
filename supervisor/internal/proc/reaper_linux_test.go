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

	// Raw spawn (no cmd.Wait, no group kill) so the orphan survives its parent.
	cmd := exec.Command("/bin/sh", "-c", "sleep 0.3 & echo $!; exit 0")
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout = pw
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pw.Close()
	exitCh := r.Subscribe(cmd.Process.Pid)

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
