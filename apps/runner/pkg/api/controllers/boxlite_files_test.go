package controllers

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadUsesRawBodyOnlyForOctetStream(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		want        bool
	}{
		{name: "octet stream", contentType: "application/octet-stream", want: true},
		{name: "octet stream with params", contentType: "application/octet-stream; charset=binary", want: true},
		{name: "tar archive", contentType: "application/x-tar", want: false},
		{name: "empty defaults to tar archive", contentType: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := uploadUsesRawBody(tt.contentType); got != tt.want {
				t.Fatalf("uploadUsesRawBody(%q) = %v, want %v", tt.contentType, got, tt.want)
			}
		})
	}
}

func TestStageRawUploadBodyDoesNotExtractTar(t *testing.T) {
	payload := tarBytes(t, "skills/main.py", "print('hello')\n")
	destDir := t.TempDir()

	stagedPath, err := stageRawUploadBody(bytes.NewReader(payload), destDir)
	if err != nil {
		t.Fatalf("stageRawUploadBody: %v", err)
	}

	got, err := os.ReadFile(stagedPath)
	if err != nil {
		t.Fatalf("read staged raw upload: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("raw upload was modified")
	}
	if _, err := os.Stat(filepath.Join(destDir, "skills")); !os.IsNotExist(err) {
		t.Fatalf("raw upload unexpectedly extracted tar entry, stat err=%v", err)
	}
}

func TestExtractTarToDirStillExtractsTar(t *testing.T) {
	destDir := t.TempDir()

	stagedPath, isSingleFile, err := extractTarToDir(bytes.NewReader(tarBytes(t, "skills/main.py", "print('hello')\n")), destDir)
	if err != nil {
		t.Fatalf("extractTarToDir: %v", err)
	}
	if !isSingleFile {
		t.Fatalf("isSingleFile = false, want true")
	}
	if stagedPath != filepath.Join(destDir, "skills", "main.py") {
		t.Fatalf("stagedPath = %q, want extracted file path", stagedPath)
	}
	got, err := os.ReadFile(stagedPath)
	if err != nil {
		t.Fatalf("read extracted file: %v", err)
	}
	if string(got) != "print('hello')\n" {
		t.Fatalf("extracted content = %q", got)
	}
}

func tarBytes(t *testing.T, name, content string) []byte {
	t.Helper()

	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{
		Name: name,
		Mode: 0o644,
		Size: int64(len(content)),
	}); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := tw.Write([]byte(content)); err != nil {
		t.Fatalf("write tar body: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	return buf.Bytes()
}
