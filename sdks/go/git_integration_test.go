//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

// TestIntegrationGitStatus proves Status / Branches reach the guest through
// the C FFI (boxlite_git_status / boxlite_git_branches) and decode. A single
// box is reused because creating a VM dominates the test cost.
func TestIntegrationGitStatus(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(
		t,
		rt,
		"alpine:latest",
		WithNetwork(NetworkSpec{
			Outbound: OutboundNetworkSpec{Mode: NetworkModeEnabled},
		}),
		WithAutoRemove(false),
	)
	installGitOrSkip(t, box)

	ctx := context.Background()
	git, err := box.Git()
	if err != nil {
		t.Fatalf("Git(): %v", err)
	}
	t.Cleanup(func() { _ = git.Close() })

	t.Run("Status and Branches decode guest output", func(t *testing.T) {
		guestStdout(t, box, "set -e\n"+
			"git init -q -b main /tmp/st\n"+
			"echo hi > /tmp/st/README.md\n"+
			"git -C /tmp/st add README.md\n"+
			"git -C /tmp/st -c user.name=Bot -c user.email=bot@boxlite.ai -c commit.gpgsign=false commit -qm init\n"+
			"git -C /tmp/st branch feature")
		st, err := git.Status(ctx, "/tmp/st")
		if err != nil || len(st.FileStatus) != 0 || st.CurrentBranch == nil || *st.CurrentBranch != "main" {
			t.Fatalf("clean Status = %+v, %v", st, err)
		}
		guestStdout(t, box, "echo x >> /tmp/st/README.md && echo a > '/tmp/st/with space.txt'")
		st, err = git.Status(ctx, "/tmp/st")
		if err != nil {
			t.Fatalf("Status: %v", err)
		}
		got := map[string]GitFileStatus{}
		for _, f := range st.FileStatus {
			got[f.Path] = f
		}
		if got["README.md"].WorktreeStatus != "M" || !got["with space.txt"].Untracked() {
			t.Fatalf("dirty Status = %+v", st.FileStatus)
		}
		br, err := git.Branches(ctx, "/tmp/st")
		if err != nil || br.Current == nil || *br.Current != "main" || len(br.Names) != 2 {
			t.Fatalf("Branches = %+v, %v", br, err)
		}
	})
}

func guestStdout(t *testing.T, box *Box, script string) string {
	t.Helper()
	cmd := box.Command("sh", "-c", script)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(context.Background()); err != nil {
		t.Fatalf("guest %q: %v: %s", script, err, stderr.String())
	}
	return strings.TrimSpace(out.String())
}

func installGitOrSkip(t *testing.T, box *Box) {
	t.Helper()
	cmd := box.Command("sh", "-c", "apk add --no-cache git")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(context.Background()); err != nil {
		t.Skipf("apk add git: %v: %s", err, stderr.String())
	}
}
