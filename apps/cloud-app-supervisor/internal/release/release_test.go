package release

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

type entry struct {
	name string
	typ  byte
	body string
	link string
	mode int64
}

func makeTarGz(t *testing.T, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: e.mode, Linkname: e.link}
		if e.typ == tar.TypeReg {
			hdr.Size = int64(len(e.body))
		}
		if hdr.Mode == 0 {
			hdr.Mode = 0o644
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractRejectsEscapes(t *testing.T) {
	cases := map[string][]entry{
		"dotdot":           {{name: "../evil.txt", typ: tar.TypeReg, body: "x"}},
		"nested dotdot":    {{name: "a/../../evil.txt", typ: tar.TypeReg, body: "x"}},
		"absolute":         {{name: "/etc/evil.txt", typ: tar.TypeReg, body: "x"}},
		"symlink escapes":  {{name: "lnk", typ: tar.TypeSymlink, link: "../../etc/passwd"}},
		"symlink absolute": {{name: "lnk", typ: tar.TypeSymlink, link: "/etc/passwd"}},
		"hardlink escapes": {{name: "h", typ: tar.TypeLink, link: "../outside"}},
		"device":           {{name: "dev", typ: tar.TypeChar}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			parent := t.TempDir()
			dir := filepath.Join(parent, "release")
			err := Extract(bytes.NewReader(makeTarGz(t, entries)), dir)
			if err == nil {
				t.Fatalf("expected an error")
			}
			if _, err := os.Stat(filepath.Join(parent, "evil.txt")); err == nil {
				t.Fatalf("file escaped the release dir")
			}
		})
	}
}

func TestExtractHappyPath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "r")
	data := makeTarGz(t, []entry{
		{name: "./", typ: tar.TypeDir, mode: 0o755},
		{name: "./package.json", typ: tar.TypeReg, body: `{"name":"demo"}`},
		{name: "bin/", typ: tar.TypeDir, mode: 0o755},
		{name: "bin/run.sh", typ: tar.TypeReg, body: "#!/bin/sh\necho hi\n", mode: 0o755},
		{name: "deep/er/file.txt", typ: tar.TypeReg, body: "deep"},
		{name: "link-to-pkg", typ: tar.TypeSymlink, link: "package.json"},
		{name: "deep/up", typ: tar.TypeSymlink, link: "../bin/run.sh"},
	})
	if err := Extract(bytes.NewReader(data), dir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil || string(got) != `{"name":"demo"}` {
		t.Fatalf("package.json: %q %v", got, err)
	}
	fi, err := os.Stat(filepath.Join(dir, "bin", "run.sh"))
	if err != nil || fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("run.sh should be executable: %v %v", fi, err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "deep", "er", "file.txt")); string(got) != "deep" {
		t.Fatalf("nested file: %q", got)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "link-to-pkg")); err != nil || !strings.Contains(string(got), "demo") {
		t.Fatalf("symlink inside root should resolve: %q %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "deep", "up")); err != nil || !strings.HasPrefix(string(got), "#!/bin/sh") {
		t.Fatalf("relative symlink inside root should resolve: %q %v", got, err)
	}
}

func TestExtractRejectsNonGzip(t *testing.T) {
	if err := Extract(strings.NewReader("not a tarball"), t.TempDir()); err == nil {
		t.Fatal("expected error")
	}
}

func TestPruneKeepsNewestAndCurrent(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []int{1, 2, 3, 4, 5} {
		if err := os.MkdirAll(filepath.Join(dir, strconv.Itoa(n), "sub"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Non-release entries are ignored.
	_ = os.MkdirAll(filepath.Join(dir, "scratch"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "7"), []byte("file, not dir"), 0o644)

	removed, err := Prune(dir, 3, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0] != 2 {
		t.Fatalf("removed = %v, want [2]", removed)
	}
	left, _ := List(dir)
	if want := []int{1, 3, 4, 5}; !slices.Equal(left, want) {
		t.Fatalf("left = %v, want %v", left, want)
	}
}
