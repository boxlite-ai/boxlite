package proc

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
)

// Run executes command with /bin/sh -c in dir (build steps), streams its
// stdout/stderr into hub under source, and returns the exit code. Cancelling
// ctx kills the process group. Like Service it relies on the Reaper for the
// exit status, so it must not be mixed with cmd.Wait().
func Run(ctx context.Context, r *Reaper, hub *logs.Hub, source string, deployment int, dir, command string, env []string) (int, error) {
	return RunAs(ctx, r, hub, source, deployment, dir, command, env, nil)
}

// RunAs is Run with the command executed as user (nil = as the supervisor).
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
	err = cmd.Start()
	outW.Close()
	errW.Close()
	if err != nil {
		outR.Close()
		errR.Close()
		return -1, err
	}
	pid := cmd.Process.Pid
	exitCh := r.Subscribe(pid)

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
	// output pipes open forever and keep running under the next release.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	_ = cmd.Process.Release()
	wg.Wait()
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
