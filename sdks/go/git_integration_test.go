//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

// TestIntegrationGitConfig proves that ConfigureUser / SetConfig / GetConfig
// actually reach guest git config — i.e. the Go SDK's git handle plumbing
// makes it through the C FFI and out the other side. A single box is reused
// for all checks because creating a VM dominates the test cost.
//
// Each subtest asserts a project-symbol path:
//   - ConfigureUser: Git.ConfigureUser -> boxlite_git_configure_user ->
//     GitHandle::configure_user -> git config --global
//   - GetConfig:     Git.GetConfig -> boxlite_git_get_config ->
//     GitHandle::get_config -> git config --get
//   - SetConfig local: Git.SetConfig(scope=local, path) -> working_dir ->
//     git config --local
//   - GetConfig local: Git.GetConfig(scope=local, path) -> git config --get
//   - Missing path:  Git.SetConfig(scope=local) -> InvalidArgument (no guest exec)
func TestIntegrationGitConfig(t *testing.T) {
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

	// Short-lived `git config --get` can exit so fast that Wait returns
	// before the stdout pump delivers the last bytes. Same pad as
	// TestIntegrationExecEnvWorkingDirTimeout.
	const drainPad = " && sleep 0.1"

	t.Run("ConfigureUser reaches guest global config", func(t *testing.T) {
		if err := git.ConfigureUser(ctx, "BoxLite Bot", "bot@boxlite.ai", nil); err != nil {
			t.Fatalf("ConfigureUser: %v", err)
		}
		email := guestStdout(t, box, "git config --global --get user.email"+drainPad)
		if email != "bot@boxlite.ai" {
			t.Fatalf("user.email did not reach guest: want bot@boxlite.ai, got %q", email)
		}
		name := guestStdout(t, box, "git config --global --get user.name"+drainPad)
		if name != "BoxLite Bot" {
			t.Fatalf("user.name did not reach guest: want BoxLite Bot, got %q", name)
		}

		log := guestStdout(t, box, "set -e\n"+
			"git init /tmp/repo\n"+
			"echo hi > /tmp/repo/README\n"+
			"git -C /tmp/repo add README\n"+
			"git -C /tmp/repo -c commit.gpgsign=false commit -m init\n"+
			"git -C /tmp/repo log -1 --format='%an <%ae>'"+drainPad)
		if !strings.Contains(log, "BoxLite Bot <bot@boxlite.ai>") {
			t.Fatalf("commit did not record configured author: got %q", log)
		}
	})

	t.Run("GetConfig reads guest global config", func(t *testing.T) {
		set := box.Command("sh", "-c", "git config --global user.email other@boxlite.ai")
		if err := set.Run(ctx); err != nil {
			t.Fatalf("git config --global user.email: %v", err)
		}
		email, err := git.GetConfig(ctx, "user.email", nil)
		if err != nil {
			t.Fatalf("GetConfig: %v", err)
		}
		if email != "other@boxlite.ai" {
			t.Fatalf("GetConfig did not read guest: want other@boxlite.ai, got %q", email)
		}
		if err := git.ConfigureUser(ctx, "BoxLite Bot", "bot@boxlite.ai", nil); err != nil {
			t.Fatalf("restore ConfigureUser: %v", err)
		}
	})

	t.Run("local scope without path is InvalidArgument", func(t *testing.T) {
		err := git.SetConfig(ctx, "user.email", "local@boxlite.ai", &GitConfigOptions{
			Scope: "local",
		})
		if err == nil {
			t.Fatal("SetConfig(local, no path) succeeded, want InvalidArgument")
		}
		var boxliteErr *Error
		if !errors.As(err, &boxliteErr) || boxliteErr.Code != ErrInvalidArgument {
			t.Fatalf("error = %v, want InvalidArgument", err)
		}
		if !strings.Contains(boxliteErr.Message, "path") {
			t.Fatalf("error %q should name path", boxliteErr.Message)
		}
	})

	t.Run("SetConfig local reaches that repo only", func(t *testing.T) {
		init := box.Command("git", "init", "/tmp/repo")
		if err := init.Run(ctx); err != nil {
			t.Fatalf("git init: %v", err)
		}
		if err := git.SetConfig(ctx, "user.email", "local@boxlite.ai", &GitConfigOptions{
			Scope: "local",
			Path:  "/tmp/repo",
		}); err != nil {
			t.Fatalf("SetConfig local: %v", err)
		}
		localEmail := guestStdout(t, box, "git -C /tmp/repo config --local --get user.email"+drainPad)
		if localEmail != "local@boxlite.ai" {
			t.Fatalf("local user.email did not reach guest: want local@boxlite.ai, got %q", localEmail)
		}
		gotLocal, err := git.GetConfig(ctx, "user.email", &GitConfigOptions{
			Scope: "local",
			Path:  "/tmp/repo",
		})
		if err != nil {
			t.Fatalf("GetConfig local: %v", err)
		}
		if gotLocal != "local@boxlite.ai" {
			t.Fatalf("GetConfig local = %q, want local@boxlite.ai", gotLocal)
		}
		globalEmail := guestStdout(t, box, "git config --global --get user.email"+drainPad)
		if globalEmail != "bot@boxlite.ai" {
			t.Fatalf("global user.email changed: want bot@boxlite.ai, got %q", globalEmail)
		}
		gotGlobal, err := git.GetConfig(ctx, "user.email", nil)
		if err != nil {
			t.Fatalf("GetConfig global: %v", err)
		}
		if gotGlobal != "bot@boxlite.ai" {
			t.Fatalf("GetConfig global = %q, want bot@boxlite.ai", gotGlobal)
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
