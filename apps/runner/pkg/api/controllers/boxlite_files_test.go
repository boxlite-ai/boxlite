package controllers

import (
	"archive/tar"
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestParseSourceIsDir(t *testing.T) {
	cases := []struct {
		raw     string
		want    bool
		hasHint bool
	}{
		{"", false, false},
		{"true", true, true},
		{"false", false, true},
		{"1", true, true},
		{"0", false, true},
		{"bogus", false, false},
	}
	for _, c := range cases {
		got, has := parseSourceIsDir(c.raw)
		if got != c.want || has != c.hasHint {
			t.Errorf("parseSourceIsDir(%q) = (%v,%v), want (%v,%v)", c.raw, got, has, c.want, c.hasHint)
		}
	}
}

func TestIsBodyTooLarge(t *testing.T) {
	inner := &http.MaxBytesError{Limit: 1024}
	wrapped := fmt.Errorf("extract: %w", inner)
	if !isBodyTooLarge(wrapped) {
		t.Fatal("isBodyTooLarge did not detect a wrapped *http.MaxBytesError")
	}
	if isBodyTooLarge(errors.New("plain error")) {
		t.Fatal("isBodyTooLarge false-positive on a plain error")
	}
}

func TestExtractTarToDirSingleFile(t *testing.T) {
	dir := t.TempDir()
	buf := buildTar(t, []tarEntry{
		{name: "file.txt", typ: tar.TypeReg, content: []byte("hello")},
	})

	last, single, err := extractTarToDir(buf, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !single {
		t.Fatal("single regular file must be detected as isSingleFile")
	}
	if filepath.Base(last) != "file.txt" {
		t.Fatalf("last file = %q, want file.txt", last)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "file.txt")); string(got) != "hello" {
		t.Fatalf("extracted content = %q, want hello", got)
	}
}

func TestExtractTarToDirDirectory(t *testing.T) {
	dir := t.TempDir()
	buf := buildTar(t, []tarEntry{
		{name: "sub/", typ: tar.TypeDir},
		{name: "sub/deep.txt", typ: tar.TypeReg, content: []byte("nested")},
	})

	_, single, err := extractTarToDir(buf, dir)
	if err != nil {
		t.Fatal(err)
	}
	if single {
		t.Fatal("a directory tree must not be detected as a single file")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "sub", "deep.txt")); string(got) != "nested" {
		t.Fatalf("extracted content = %q, want nested", got)
	}
}

func TestExtractTarToDirRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	buf := buildTar(t, []tarEntry{
		{name: "../evil.txt", typ: tar.TypeReg, content: []byte("x")},
	})

	if _, _, err := extractTarToDir(buf, dir); err == nil {
		t.Fatal("a tar entry escaping the staging dir must be rejected")
	}
}

type tarEntry struct {
	name    string
	typ     byte
	content []byte
}

func buildTar(t *testing.T, entries []tarEntry) *bytes.Buffer {
	t.Helper()
	buf := new(bytes.Buffer)
	tw := tar.NewWriter(buf)
	for _, e := range entries {
		hdr := &tar.Header{
			Name:     e.name,
			Typeflag: e.typ,
			Mode:     0o644,
			Size:     int64(len(e.content)),
		}
		if e.typ == tar.TypeDir {
			hdr.Mode = 0o755
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(e.content); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf
}
