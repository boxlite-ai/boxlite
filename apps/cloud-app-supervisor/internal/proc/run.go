package proc

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
)

// pumpDrain bounds how long RunAs waits for the output pumps once the build
// step's process group is dead. A daemonised grandchild (setsid, double fork)
// escapes the group kill and can hold the pipes open forever; after this long
// the pipes are closed under it so the step still returns.
var pumpDrain = 5 * time.Second

// RunAs executes command with /bin/sh -c in dir (build steps) as user (nil =
// as the supervisor), streams its stdout/stderr into hub under source, and
// returns the exit code. Cancelling ctx kills the process group and returns
// ctx.Err(). It relies on the Reaper for the exit status, so it must not be
// mixed with cmd.Wait().
func RunAs(ctx context.Context, r *Reaper, hub *logs.Hub, source string, deployment int, dir, command string, env []string, user *Cred) (int, error) {
	cmd := exec.Command("/bin/sh", "-c", command)
	cmd.Dir = dir
	cmd.Env = env
	cmd.SysProcAttr = user.sysProcAttr()
	outR, outW, err := os.Pipe()
	if err != nil {
		return -1, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return -1, err
	}
	cmd.Stdout, cmd.Stderr = outW, errW
	exitCh, err := r.Start(cmd)
	outW.Close()
	errW.Close()
	if err != nil {
		outR.Close()
		errR.Close()
		return -1, err
	}
	pid := cmd.Process.Pid

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pump(outR, hub, source, api.LevelInfo, deployment) }()
	go func() { defer wg.Done(); pump(errR, hub, source, api.LevelError, deployment) }()

	var ws syscall.WaitStatus
	cancelled := false
	select {
	case ws = <-exitCh:
	case <-ctx.Done():
		cancelled = true
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		ws = <-exitCh
	}
	// The leader is gone. Anything it left behind in its group (a watcher, a
	// forgotten dev server) must not outlive the build step: it would hold the
	// output pipes open and keep running under the next release.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	_ = cmd.Process.Release()
	pumped := make(chan struct{})
	go func() { wg.Wait(); close(pumped) }()
	select {
	case <-pumped:
	case <-time.After(pumpDrain):
		// Closing the read ends makes the blocked reads return; pump's own
		// Close afterwards is a harmless no-op.
		outR.Close()
		errR.Close()
		<-pumped
		hub.Systemf(deployment, api.LevelError, "build step left a process outside its group holding its output open; stopped reading it")
	}
	if cancelled {
		return -1, ctx.Err()
	}
	return ExitCode(ws), nil
}

// pump copies one stdio pipe into the hub line by line until EOF. EOF arrives
// only once every holder of the write end (children included) is gone.
func pump(r *os.File, hub *logs.Hub, source, level string, deployment int) {
	defer r.Close()
	br := newLineReader(r)
	for {
		line, err := readLine(br)
		if line != "" {
			hub.Emit(api.LogLine{Source: source, Level: level, Line: line, Deployment: deployment})
		}
		if err != nil {
			return
		}
	}
}
