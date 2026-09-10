// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

// mountArgv returns the mount binary and its arguments, unwrapping the
// transient-scope wrapper when getMountCmd took the systemd branch. Tests
// assert on the mount command itself; whether systemd wraps it is a property
// of the host, not of the argv under test.
func mountArgv(t *testing.T, cmd *exec.Cmd) (string, []string) {
	t.Helper()

	args := cmd.Args
	if len(args) == 0 {
		t.Fatal("mount command has no argv")
	}
	if filepathBase(args[0]) != "systemd-run" {
		return filepathBase(args[0]), args[1:]
	}
	for i, a := range args {
		if a == "--" {
			if i+1 >= len(args) {
				t.Fatal("systemd-run argv ends at the -- separator")
			}
			return args[i+1], args[i+2:]
		}
	}
	t.Fatalf("systemd-run argv has no -- separator: %v", args)
	return "", nil
}

func filepathBase(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

// scopeEnvSetenv returns the --setenv= values systemd-run was asked to pass
// through, or nil when getMountCmd took the plain exec branch.
func scopeEnvSetenv(cmd *exec.Cmd) []string {
	var out []string
	for _, a := range cmd.Args {
		if a == "--" {
			break
		}
		if len(a) > len("--setenv=") && a[:len("--setenv=")] == "--setenv=" {
			out = append(out, a[len("--setenv="):])
		}
	}
	return out
}

// mountEnv returns the credential environment the mount process will see,
// from whichever branch getMountCmd took.
func mountEnv(cmd *exec.Cmd) []string {
	if e := scopeEnvSetenv(cmd); e != nil {
		return e
	}
	return cmd.Env
}

func testClient(t *testing.T) *Client {
	t.Helper()
	return &Client{logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
}

// The production shape: no AWS_* is injected on a runner host, so mount-s3
// falls through to the instance role. Pinned byte-for-byte because the GCS
// backend must not perturb it.
func TestMountS3ArgvWithoutCredentials(t *testing.T) {
	c := testClient(t)

	bin, args := mountArgv(t, c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc"))

	if bin != "mount-s3" {
		t.Errorf("mount binary = %q, want mount-s3", bin)
	}
	want := []string{
		"--allow-other", "--allow-delete", "--allow-overwrite",
		"--file-mode", "0666", "--dir-mode", "0777",
		"boxlite-volume-abc", "/mnt/boxlite-volume-abc",
	}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("argv mismatch\n got: %v\nwant: %v", args, want)
	}
}

// The MinIO / development shape: all four AWS_* are injected, in this order.
func TestMountS3ArgvWithCredentials(t *testing.T) {
	c := testClient(t)
	c.awsEndpointUrl = "http://minio:9000"
	c.awsAccessKeyId = "minioadmin"
	c.awsSecretAccessKey = "minioadmin"
	c.awsRegion = "us-east-1"

	cmd := c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc")

	bin, args := mountArgv(t, cmd)
	if bin != "mount-s3" {
		t.Errorf("mount binary = %q, want mount-s3", bin)
	}
	want := []string{
		"--allow-other", "--allow-delete", "--allow-overwrite",
		"--file-mode", "0666", "--dir-mode", "0777",
		"boxlite-volume-abc", "/mnt/boxlite-volume-abc",
	}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("argv mismatch\n got: %v\nwant: %v", args, want)
	}

	wantEnv := []string{
		"AWS_ENDPOINT_URL=http://minio:9000",
		"AWS_ACCESS_KEY_ID=minioadmin",
		"AWS_SECRET_ACCESS_KEY=minioadmin",
		"AWS_REGION=us-east-1",
	}
	if got := mountEnv(cmd); !reflect.DeepEqual(got, wantEnv) {
		t.Errorf("credential env mismatch\n got: %v\nwant: %v", got, wantEnv)
	}
}

// A partially configured backend injects only what is set: a lone region must
// not synthesise empty key variables, which mount-s3 would read as a broken
// static credential pair instead of falling back to the instance role.
func TestMountS3ArgvInjectsOnlyConfiguredCredentials(t *testing.T) {
	c := testClient(t)
	c.awsRegion = "eu-west-1"

	cmd := c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc")

	wantEnv := []string{"AWS_REGION=eu-west-1"}
	if got := mountEnv(cmd); !reflect.DeepEqual(got, wantEnv) {
		t.Errorf("credential env mismatch\n got: %v\nwant: %v", got, wantEnv)
	}
}

// The GCS argv is deliberately not a translation of the mount-s3 one; the
// differences that matter are pinned here so a later edit cannot drop them.
func TestGcsfuseArgv(t *testing.T) {
	c := testClient(t)
	c.volumeBackend = volumeBackendGCS

	bin, args := mountArgv(t, c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc"))

	if bin != "gcsfuse" {
		t.Errorf("mount binary = %q, want gcsfuse", bin)
	}
	want := []string{
		"-o", "allow_other",
		"--file-mode", "0666",
		"--dir-mode", "0777",
		"--implicit-dirs",
		"--metadata-cache-ttl-secs", "0",
		"boxlite-volume-abc", "/mnt/boxlite-volume-abc",
	}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("argv mismatch\n got: %v\nwant: %v", args, want)
	}
}

// mount-s3's flags are hard errors on gcsfuse, so a translation that leaked
// them through would fail at mount time rather than at review time.
func TestGcsfuseArgvOmitsMountS3OnlyFlags(t *testing.T) {
	c := testClient(t)
	c.volumeBackend = volumeBackendGCS

	_, args := mountArgv(t, c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc"))

	for _, rejected := range []string{"--allow-other", "--allow-delete", "--allow-overwrite"} {
		for _, got := range args {
			if got == rejected {
				t.Errorf("gcsfuse argv carries mount-s3 flag %q, which gcsfuse rejects as an unknown flag", rejected)
			}
		}
	}
}

// The GCS spec adds no credential environment of its own, so a configured
// AWS_* pair cannot be turned into a systemd-run --setenv= argument, where
// /proc/<pid>/cmdline would expose it to every local user. This says nothing
// about the runner's own environment: cmd.Env is nil, so the child still
// inherits os.Environ() — that is how an off-GCE
// GOOGLE_APPLICATION_CREDENTIALS reaches gcsfuse.
func TestGcsfuseCarriesNoCredentialEnv(t *testing.T) {
	c := testClient(t)
	c.volumeBackend = volumeBackendGCS
	c.awsEndpointUrl = "http://minio:9000"
	c.awsAccessKeyId = "minioadmin"
	c.awsSecretAccessKey = "minioadmin"
	c.awsRegion = "us-east-1"

	cmd := c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc")

	if got := mountEnv(cmd); len(got) != 0 {
		t.Errorf("gcsfuse must carry no credential env, got %v", got)
	}
	for _, a := range cmd.Args {
		if a == "--setenv=AWS_SECRET_ACCESS_KEY=minioadmin" {
			t.Error("secret leaked into systemd-run argv")
		}
	}
}

// Compatibility: an existing deployment sets no VOLUME_STORAGE_BACKEND, so the
// zero value must select mount-s3 rather than an unconfigured backend.
func TestUnsetBackendSelectsMountS3(t *testing.T) {
	c := testClient(t)
	c.volumeBackend = ""

	bin, _ := mountArgv(t, c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc"))
	if bin != "mount-s3" {
		t.Errorf("unset backend selected %q, want mount-s3", bin)
	}

	c.volumeBackend = volumeBackendS3
	bin, _ = mountArgv(t, c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc"))
	if bin != "mount-s3" {
		t.Errorf("explicit s3 backend selected %q, want mount-s3", bin)
	}
}

// Pins the exec to the context. gcsfuse retries an unreachable bucket forever
// and the request context carries no deadline, so ensureVolumeFuseMounted's
// volumeMountTimeout is the only thing that can end such a mount — and it can
// only do so if the command is built with CommandContext. Asserted through
// Cmd.Cancel, which exec.CommandContext sets and exec.Command leaves nil:
// running the command instead would only report whichever mount binary this
// host happens to be missing.
func TestMountCmdIsBoundToTheContext(t *testing.T) {
	for _, backend := range []string{volumeBackendS3, volumeBackendGCS} {
		t.Run(backend, func(t *testing.T) {
			c := testClient(t)
			c.volumeBackend = backend

			cmd := c.getMountCmd(context.Background(), "boxlite-volume-abc", "/mnt/boxlite-volume-abc")
			if cmd.Cancel == nil {
				t.Error("mount command is not context-bound; a hung mount could not be killed")
			}
		})
	}
}

// The probe and teardown run against a mount whose backend may be gone, where
// stat and umount block on the kernel. Asserted through Cmd.Cancel, which
// exec.CommandContext sets and exec.Command leaves nil: running them proves
// nothing, since both fail on an ordinary directory whatever the context says.
func TestMountProbeAndTeardownAreContextBound(t *testing.T) {
	ctx := context.Background()

	if mountProbeCmd(ctx, "/mnt/x").Cancel == nil {
		t.Error("mountpoint probe is not context-bound; a dead mount would block it forever")
	}
	if umountCmd(ctx, "/mnt/x").Cancel == nil {
		t.Error("umount is not context-bound; cleanup would inherit the hang it exists to clear")
	}
}

// The two things that trigger the post-failure teardown — volumeMountTimeout
// firing and the client disconnecting — both leave the caller's context
// cancelled, and every exec under a cancelled context returns without running.
// A cleanup context derived from it would therefore do nothing in exactly the
// cases it exists for, leaving a stale FUSE mount behind.
func TestCleanupContextSurvivesCallerCancellation(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	cancel()

	cleanupCtx, done := cleanupContext(parent)
	defer done()

	if err := cleanupCtx.Err(); err != nil {
		t.Fatalf("cleanup context inherited the caller's cancellation: %v", err)
	}
	if _, ok := cleanupCtx.Deadline(); !ok {
		t.Error("cleanup context has no deadline; a wedged unmount would hang it forever")
	}
}

// A readiness wait that ends must say which of the two things happened. The
// probe cannot tell them apart on its own: under a finished context it returns
// before it runs, which reads exactly like an unmounted path.
func TestNotReadyErrorDistinguishesTimeoutFromCancellation(t *testing.T) {
	expired, cancelExpired := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelExpired()

	if err := notReadyError(context.Background(), expired); err == nil ||
		!strings.Contains(err.Error(), "did not become ready") {
		t.Errorf("our own bound expiring must report a timeout, got %v", err)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := notReadyError(cancelled, cancelled); err == nil ||
		!strings.Contains(err.Error(), "context cancelled") {
		t.Errorf("a cancelled caller must be reported as cancellation, got %v", err)
	}
}

// Teardown ordering: the directory may only go once nothing is mounted on it.
func TestShouldRemoveMountDir(t *testing.T) {
	for _, tc := range []struct {
		name       string
		dirExisted bool
		unmountErr error
		want       bool
	}{
		{"created by us and unmounted cleanly", false, nil, true},
		{"created by us but still mounted", false, errors.New("device busy"), false},
		{"pre-existing directory is never ours to delete", true, nil, false},
		{"pre-existing and still mounted", true, errors.New("device busy"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldRemoveMountDir(tc.dirExisted, tc.unmountErr); got != tc.want {
				t.Errorf("shouldRemoveMountDir(%v, %v) = %v, want %v", tc.dirExisted, tc.unmountErr, got, tc.want)
			}
		})
	}
}

// The probe must never answer "not mounted" when it could not run. Callers use
// that answer to decide whether a mount already exists and whether one is
// theirs to tear down, so a false negative makes them mount over a live mount
// or unmount a directory they never created.
func TestMountProbeSeparatesCannotRunFromNotMounted(t *testing.T) {
	c := testClient(t)
	dir := t.TempDir()

	mounted, err := c.isDirectoryMounted(context.Background(), dir)
	if err != nil || mounted {
		t.Fatalf("an ordinary directory is simply not a mountpoint, got mounted=%v err=%v", mounted, err)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	mounted, err = c.isDirectoryMounted(cancelled, dir)
	if err == nil {
		t.Error("a probe that could not run reported an answer instead of an error")
	}
	if mounted {
		t.Error("a probe that could not run must not claim the path is mounted")
	}
}
