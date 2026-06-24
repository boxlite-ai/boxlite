//go:build boxlite_dev

package boxlite

import (
	"context"
	"testing"
	"time"
)

// TestIntegrationExecPipeConsumerExitsEarly proves that a pipeline whose
// downstream consumer exits before the upstream producer finishes does not hang
// the exec.
//
// The guest agent is a Rust program, and the Rust runtime installs SIG_IGN for
// SIGPIPE at startup. That disposition used to be inherited by every container
// process the guest forks, so a producer that writes to a pipe whose reader has
// already exited got EPIPE instead of being killed by SIGPIPE. A producer that
// loops without checking write errors (`yes`, or a shell `while :; do echo`
// loop) then never terminated: it spun, the pipeline never completed, the exec
// never exited, and Wait blocked forever while a vCPU stayed pegged.
//
// The guest now restores the default SIGPIPE disposition across the container
// fork, so such a producer is killed by SIGPIPE and the exec completes promptly.
//
// Pre-fix this hangs deterministically; post-fix it returns in well under a
// second. The generous watchdog distinguishes "fixed" from "hung" without being
// sensitive to host timing.
func TestIntegrationExecPipeConsumerExitsEarly(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	// Two producers that both rely on SIGPIPE to die when `head` closes the
	// pipe: busybox `yes`, and the very common shell `while :; do echo; done`
	// idiom. The 8-byte payload is one that reproduced the hang deterministically.
	cases := []struct {
		name string
		cmd  string
	}{
		{"busybox-yes", "yes aaaaaaaa | head -n 5"},
		{"shell-echo-loop", "while :; do echo aaaaaaaa; done | head -n 5"},
	}

	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			cmd := box.Command("sh", "-c", c.cmd)
			done := make(chan error, 1)
			go func() { done <- cmd.Run(context.Background()) }()

			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("exec returned error: %v", err)
				}
			case <-time.After(20 * time.Second):
				t.Fatalf("exec HUNG: %q did not return within 20s — the producer "+
					"spun on a closed pipe because SIGPIPE was not reset to "+
					"SIG_DFL for the container process", c.cmd)
			}
		})
	}
}
