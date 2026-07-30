// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package rollout

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeCacheDirNameSeparatesDevBuildsFromReleases(t *testing.T) {
	// The whole point of the suffix: a dev build of 0.9.7 must not land in the
	// same runtime cache directory as the 0.9.7 release, or the release's
	// extracted guest silently becomes the dev build's guest.
	release := RuntimeCacheDirName("0.9.7", "")
	dev := RuntimeCacheDirName("0.9.7-dev-123-58d8f01bcd02", "dev-123-58d8f01bcd02")

	if release != "v0.9.7" {
		t.Errorf("release cache dir = %q, want v0.9.7", release)
	}
	if dev != "v0.9.7-dev-123-58d8f01bcd02" {
		t.Errorf("dev cache dir = %q, want v0.9.7-dev-123-58d8f01bcd02", dev)
	}
	if release == dev {
		t.Fatal("dev build shares the release runtime cache directory")
	}
}

func TestRuntimeCacheDirNameStripsDevSegmentFromBaseVersion(t *testing.T) {
	// A dev version carries its suffix in the version string too; the base must
	// be taken from before "-dev-" so the directory is not doubled up.
	got := RuntimeCacheDirName("0.9.7-dev-9-abc", "dev-9-abc")
	if got != "v0.9.7-dev-9-abc" {
		t.Errorf("cache dir = %q, want v0.9.7-dev-9-abc", got)
	}
}

func TestSafeJoinRejectsEscapingEntries(t *testing.T) {
	root := t.TempDir()

	for _, name := range []string{
		"../escape",
		"nested/../../escape",
		"/absolute/path",
		"..",
	} {
		if _, err := safeJoin(root, name); err == nil {
			t.Errorf("safeJoin accepted escaping entry %q", name)
		}
	}

	for _, name := range []string{"boxlite-guest", "nested/lib.so", "./boxlite-shim"} {
		got, err := safeJoin(root, name)
		if err != nil {
			t.Errorf("safeJoin rejected legitimate entry %q: %v", name, err)
			continue
		}
		if !strings.HasPrefix(got, root) {
			t.Errorf("safeJoin(%q) = %q, which is outside %q", name, got, root)
		}
	}
}

func TestExtractTarGzRefusesPathTraversal(t *testing.T) {
	dir := t.TempDir()
	tarball := filepath.Join(dir, "evil.tar.gz")
	writeTarGz(t, tarball, map[string]string{"../escaped": "owned"})

	dest := filepath.Join(dir, "dest")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := extractTarGz(tarball, dest); err == nil {
		t.Fatal("extractTarGz accepted an entry that escapes the destination")
	}
	if _, err := os.Stat(filepath.Join(dir, "escaped")); err == nil {
		t.Fatal("extractTarGz wrote outside the destination directory")
	}
}

func TestExtractTarGzWritesRegularEntries(t *testing.T) {
	dir := t.TempDir()
	tarball := filepath.Join(dir, "payload.tar.gz")
	writeTarGz(t, tarball, map[string]string{
		"boxlite-guest":   "guest-bytes",
		"libkrunfw.so.5":  "kernel-bytes",
		"nested/thing.so": "nested-bytes",
	})

	dest := filepath.Join(dir, "dest")
	if err := extractTarGz(tarball, dest); err != nil {
		t.Fatalf("extractTarGz: %v", err)
	}
	for name, want := range map[string]string{
		"boxlite-guest":   "guest-bytes",
		"libkrunfw.so.5":  "kernel-bytes",
		"nested/thing.so": "nested-bytes",
	} {
		got, err := os.ReadFile(filepath.Join(dest, name))
		if err != nil {
			t.Errorf("read %s: %v", name, err)
			continue
		}
		if string(got) != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestDesiredStateValidateRejectsUnusableStates(t *testing.T) {
	const validSHA = "3b1f8a2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"

	valid := DesiredState{Version: "0.9.7", URL: "https://example.com/a.tar.gz", SHA256: validSHA}
	if err := valid.validate(); err != nil {
		t.Fatalf("valid desired state rejected: %v", err)
	}
	s3State := DesiredState{Version: "0.9.7-dev-1-abc", URL: "s3://bucket/key.tar.gz", SHA256: validSHA}
	if err := s3State.validate(); err != nil {
		t.Fatalf("s3 desired state rejected: %v", err)
	}

	for name, state := range map[string]DesiredState{
		"no version":    {URL: "https://example.com/a.tar.gz", SHA256: validSHA},
		"no url":        {Version: "0.9.7", SHA256: validSHA},
		"file url":      {Version: "0.9.7", URL: "file:///tmp/a.tar.gz", SHA256: validSHA},
		"no sha":        {Version: "0.9.7", URL: "https://example.com/a.tar.gz"},
		"short sha":     {Version: "0.9.7", URL: "https://example.com/a.tar.gz", SHA256: "abc123"},
		"uppercase sha": {Version: "0.9.7", URL: "https://example.com/a.tar.gz", SHA256: strings.ToUpper(validSHA)},
	} {
		if err := state.validate(); err == nil {
			t.Errorf("validate accepted a state with %s", name)
		}
	}
}

func TestInstalledStateMatchesOnChecksumNotJustVersion(t *testing.T) {
	const shaA = "3b1f8a2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"
	const shaB = "0000000000000000000000000000000000000000000000000000000000000000"

	installed := InstalledState{Version: "0.9.7", SHA256: shaA}
	if !installed.matches(DesiredState{Version: "0.9.7", SHA256: shaA}) {
		t.Error("identical version+checksum did not match")
	}
	// A rebuilt artifact under the same version must still trigger a reconcile,
	// otherwise a re-published dev build would never reach the box.
	if installed.matches(DesiredState{Version: "0.9.7", SHA256: shaB}) {
		t.Error("same version with a different checksum was treated as already installed")
	}
}

func TestParseProcStatSurvivesCommWithSpacesAndParens(t *testing.T) {
	// Fields 1..3 are pid, comm, state; field 22 is starttime. Build a line
	// whose comm contains both a space and a ')' — the case a naive split on
	// whitespace gets wrong.
	fields := make([]string, 0, 50)
	fields = append(fields, "R") // field 3: state
	for i := 4; i <= 52; i++ {
		if i == 22 {
			fields = append(fields, "884422")
			continue
		}
		fields = append(fields, "0")
	}
	raw := "4242 (boxlite shim (v2)) " + strings.Join(fields, " ") + "\n"

	parsed := parseProcStat(raw)
	if len(parsed) < 20 {
		t.Fatalf("parseProcStat returned %d fields, want at least 20", len(parsed))
	}
	if parsed[0] != "R" {
		t.Errorf("state = %q, want R", parsed[0])
	}
	if parsed[19] != "884422" {
		t.Errorf("starttime = %q, want 884422", parsed[19])
	}
}

func TestSanitizeSuffixKeepsSuffixUsableAsOnePathSegment(t *testing.T) {
	for raw, want := range map[string]string{
		"dev-123-58d8f01bcd02\n": "dev-123-58d8f01bcd02",
		"  dev-1-abc  ":          "dev-1-abc",
		"":                       "",
		"\n":                     "",
		"../../etc/passwd":       "....etcpasswd",
		"a/b":                    "ab",
	} {
		if got := sanitizeSuffix(raw); got != want {
			t.Errorf("sanitizeSuffix(%q) = %q, want %q", raw, got, want)
		}
	}
	// Whatever the input, the result must never introduce a path separator.
	if got := sanitizeSuffix("dev/../../root"); strings.ContainsAny(got, `/\`) {
		t.Errorf("sanitizeSuffix leaked a path separator: %q", got)
	}
}

func TestReadShimPidParsesPidAndStartTime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shim.pid")
	if err := os.WriteFile(path, []byte("4242\n884422\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	shim, ok := readShimPid(path, "box-abc")
	if !ok {
		t.Fatal("readShimPid rejected a well-formed shim.pid")
	}
	if shim.pid != 4242 || shim.startTime != "884422" || shim.boxID != "box-abc" {
		t.Errorf("got %+v, want pid=4242 startTime=884422 boxID=box-abc", shim)
	}

	if _, ok := readShimPid(filepath.Join(dir, "missing.pid"), "box-x"); ok {
		t.Error("readShimPid accepted a missing file")
	}

	garbage := filepath.Join(dir, "garbage.pid")
	if err := os.WriteFile(garbage, []byte("not-a-pid\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := readShimPid(garbage, "box-y"); ok {
		t.Error("readShimPid accepted a non-numeric pid")
	}
}

func writeTarGz(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for name, body := range entries {
		if err := tw.WriteHeader(&tar.Header{
			Name:     name,
			Mode:     0o644,
			Size:     int64(len(body)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
}
