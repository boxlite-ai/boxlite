//go:build boxlite_dev

package boxlite

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestIntegrationOneShotExecGivesStdinEOF proves that the one-shot helpers
// hand the guest process EOF on stdin, so a command that reads stdin until
// EOF terminates on its own with empty input. Before the fix nothing closed
// stdin until after Wait returned, and the call blocked until the context
// deadline.
func TestIntegrationOneShotExecGivesStdinEOF(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := box.Exec(ctx, "wc", "-c")
	if err != nil {
		t.Fatalf("Box.Exec wc -c: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("Box.Exec wc -c: exit code %d, want 0", res.ExitCode)
	}
	if got := strings.TrimSpace(res.Stdout); got != "0" {
		t.Fatalf("Box.Exec wc -c: stdout %q, want \"0\" (empty stdin)", got)
	}
}
