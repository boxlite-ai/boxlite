//go:build boxlite_dev

package boxlite

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
)

func TestCopyInStreamOverwritePreservesExistingBytes(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(t, rt, "alpine:latest")
	ctx := context.Background()
	const destination = "/root/overwrite-proof.txt"
	archive := func(content string) io.Reader {
		var data bytes.Buffer
		writer := tar.NewWriter(&data)
		if err := writer.WriteHeader(&tar.Header{Name: "source.txt", Mode: 0644, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return bytes.NewReader(data.Bytes())
	}
	read := func() string {
		result, err := box.Exec(ctx, "cat", destination)
		if err != nil {
			t.Fatal(err)
		}
		if result.ExitCode != 0 {
			t.Fatalf("read original: exit=%d stderr=%q", result.ExitCode, result.Stderr)
		}
		return result.Stdout
	}

	if err := box.CopyInStream(ctx, destination, archive("original"), WithOverwrite(false)); err != nil {
		t.Fatalf("overwrite=false must create a missing destination: %v", err)
	}
	err := box.CopyInStream(ctx, destination, archive("replacement"), WithOverwrite(false))
	if err == nil || !strings.Contains(err.Error(), "overwrite=false") {
		t.Fatalf("expected overwrite=false refusal, got %v; stored bytes=%q", err, read())
	}
	if got := read(); got != "original" {
		t.Fatalf("refusal changed original bytes: %q", got)
	}
	if err := box.CopyInStream(ctx, destination, archive("explicit"), WithOverwrite(true)); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != "explicit" {
		t.Fatalf("overwrite=true bytes=%q", got)
	}
	if err := box.CopyInStream(ctx, destination, archive("default")); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != "default" {
		t.Fatalf("default overwrite behavior changed: %q", got)
	}
	if err := box.CopyInStream(ctx, destination, archive("last-true"), WithOverwrite(false), WithOverwrite(true)); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != "last-true" {
		t.Fatalf("last overwrite=true option did not win: %q", got)
	}
	err = box.CopyInStream(ctx, destination, archive("last-false"), WithOverwrite(true), WithOverwrite(false))
	if err == nil || !strings.Contains(err.Error(), "overwrite=false") {
		t.Fatalf("expected last overwrite=false option to refuse, got %v; stored bytes=%q", err, read())
	}
	if got := read(); got != "last-true" {
		t.Fatalf("last overwrite=false option changed existing bytes: %q", got)
	}
}
