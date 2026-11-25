// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestCloudSubPathSyntaxIsValidatedBeforeBackendPreparation(t *testing.T) {
	base := t.TempDir()
	useVolumeMountBasePath(t, base)
	c := filestoreTestClient(t)
	fake := installFakeFilestoreMounts(t, c)
	firstVolume := dto.VolumeDTO{
		VolumeId:  "vol-1",
		MountPath: "/data",
		Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"},
	}
	invalid := "team/../backend"
	secondVolume := dto.VolumeDTO{
		VolumeId:  "vol-2",
		MountPath: "/other",
		Subpath:   &invalid,
		Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"},
	}

	_, err := c.getVolumeMounts(context.Background(), "box1", []dto.VolumeDTO{firstVolume, secondVolume})
	if err == nil || !strings.Contains(err.Error(), "VOLUME_SUBPATH_INVALID") {
		t.Fatalf("getVolumeMounts error = %v, want VOLUME_SUBPATH_INVALID", err)
	}
	if fake.mounts.Load() != 0 {
		t.Fatalf("mount command ran %d times; syntax validation must precede backend preparation", fake.mounts.Load())
	}
	if _, err := os.Stat(filepath.Join(base, filestoreMountPrefix+"ml-scratch")); !os.IsNotExist(err) {
		t.Fatalf("backend root existed after syntax rejection (stat err: %v)", err)
	}
}

func TestCloudSubPathSyntaxAllowsPlainDotDotInsideNames(t *testing.T) {
	for _, subpath := range []string{"", "foo..bar", "team/backend", strings.Repeat("a", 255)} {
		if err := validateCloudSubPath(subpath); err != nil {
			t.Fatalf("validateCloudSubPath(%q) = %v, want nil", subpath, err)
		}
	}
	for _, subpath := range []string{
		"/team", "team/", ".", "..", "team/..", "a//b", "a\x00b", "team/../backend", strings.Repeat("a", 256),
	} {
		if err := validateCloudSubPath(subpath); err == nil {
			t.Fatalf("validateCloudSubPath(%q) = nil, want an error", subpath)
		}
	}
}

func TestCloudVolumeRootRejectsSymlinkAndFile(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.Mkdir(real, 0755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(base, "file")
	if err := os.WriteFile(file, []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := ensureCloudVolumeRoot(real, "volume root"); err != nil {
		t.Fatalf("real directory rejected: %v", err)
	}
	for _, path := range []string{link, file, filepath.Join(base, "missing")} {
		err := ensureCloudVolumeRoot(path, "volume root")
		if err == nil {
			t.Fatalf("ensureCloudVolumeRoot(%q) = nil, want an error", path)
		}
		if !strings.Contains(err.Error(), "VOLUME_ROOT_") {
			t.Fatalf("ensureCloudVolumeRoot(%q) = %v, want a stable volume error", path, err)
		}
	}
}

func TestReadOnlyFilestoreVolumeRootIsNotCreatedOrChanged(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)
	c := filestoreTestClient(t)
	installFakeFilestoreMounts(t, c)
	prepareCalls := 0
	c.prepareRunner = func(string) error {
		prepareCalls++
		return errors.New("read-only preparation must not run")
	}

	_, err := c.getVolumeMounts(ctx, "box1", []dto.VolumeDTO{{
		VolumeId:  "vol-1",
		MountPath: "/data",
		ReadOnly:  true,
		Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"},
	}})
	if err == nil || !strings.Contains(err.Error(), "VOLUME_SUBPATH_NOT_FOUND") {
		t.Fatalf("getVolumeMounts error = %v, want VOLUME_SUBPATH_NOT_FOUND", err)
	}
	if prepareCalls != 0 {
		t.Fatalf("prepare ran %d times; read-only must not create or chmod the root", prepareCalls)
	}
	if _, err := os.Stat(filepath.Join(base, filestoreMountPrefix+"ml-scratch", "vol-1")); !os.IsNotExist(err) {
		t.Fatalf("read-only Filestore volume root was created (stat err: %v)", err)
	}
}

func TestReadOnlyFilestoreExistingRootKeepsModeAndContent(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	root := filepath.Join(base, filestoreMountPrefix+"ml-scratch")
	dataDir := filestoreDataDir(root, "vol-1")
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "marker"), []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}

	c := filestoreTestClient(t)
	installFakeFilestoreMounts(t, c)
	prepareCalls := 0
	c.prepareRunner = func(string) error {
		prepareCalls++
		return errors.New("read-only preparation must not run")
	}

	mounts, err := c.getVolumeMounts(ctx, "box1", []dto.VolumeDTO{{
		VolumeId:  "vol-1",
		MountPath: "/data",
		ReadOnly:  true,
		Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"},
	}})
	if err != nil {
		t.Fatalf("getVolumeMounts failed: %v", err)
	}
	if len(mounts) != 1 || !mounts[0].readOnly {
		t.Fatalf("mounts = %#v, want one read-only mount", mounts)
	}
	if prepareCalls != 0 {
		t.Fatalf("read-only mount ran the RW volume preparation callback %d times", prepareCalls)
	}

	info, err := os.Stat(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0700 {
		t.Fatalf("read-only mount changed data directory mode: got %o, want 700", info.Mode().Perm())
	}
	data, err := os.ReadFile(filepath.Join(dataDir, "marker"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "unchanged" {
		t.Fatalf("read-only mount changed content: %q", data)
	}
}

func TestRecoveryPreflightRejectsReadOnlyFilestoreMissingRoot(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	c := filestoreTestClient(t)
	installFakeFilestoreMounts(t, c)
	readonly := true
	volume := dto.VolumeDTO{
		VolumeId:  "vol-1",
		MountPath: "/data",
		ReadOnly:  readonly,
		Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"},
	}

	err := c.preflightRecoveryVolumes(ctx, []dto.VolumeDTO{volume})
	if err == nil || !strings.Contains(err.Error(), "VOLUME_SUBPATH_NOT_FOUND") {
		t.Fatalf("preflight error = %v, want VOLUME_SUBPATH_NOT_FOUND", err)
	}
}

func TestRecoveryPreflightAllowsRWMissingSubpath(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)

	c := filestoreTestClient(t)
	installFakeFilestoreMounts(t, c)
	subpath := "team/backend"
	volume := dto.VolumeDTO{
		VolumeId:  "vol-1",
		MountPath: "/data",
		Subpath:   &subpath,
		Filestore: &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"},
	}

	if err := c.preflightRecoveryVolumes(ctx, []dto.VolumeDTO{volume}); err != nil {
		t.Fatalf("RW missing subpath should be allowed before Create: %v", err)
	}
}

func TestFilestoreMountRootRejectsSymlink(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	useVolumeMountBasePath(t, base)
	real := filepath.Join(base, "real")
	if err := os.Mkdir(real, 0755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, filestoreMountPrefix+"ml-scratch")
	if err := os.Symlink(real, root); err != nil {
		t.Fatal(err)
	}

	c := filestoreTestClient(t)
	fake := installFakeFilestoreMounts(t, c)
	ref := &dto.FilestoreRef{Instance: "ml-scratch", Server: "10.0.0.7", Export: "/vol1"}
	err := c.ensureFilestoreMounted(ctx, ref, root, filestoreMountPrefix+"ml-scratch")
	if err == nil || !strings.Contains(err.Error(), "VOLUME_ROOT_INVALID") {
		t.Fatalf("ensureFilestoreMounted error = %v, want VOLUME_ROOT_INVALID", err)
	}
	if fake.mounts.Load() != 0 {
		t.Fatalf("mount command ran %d times; symlink root must be rejected before mount", fake.mounts.Load())
	}
}
