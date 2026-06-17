// Go SDK e2e: copy in/out round-trip.
// Called by cases/test_go_coverage.py.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/boxlite-ai/boxlite/sdks/go"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "FATAL: "+format+"\n", args...)
	os.Exit(2)
}

func main() {
	url := env("BOXLITE_E2E_URL", "http://localhost:3000/api")
	apiKey := env("BOXLITE_E2E_API_KEY", "devkey")
	prefix := env("BOXLITE_E2E_PREFIX", "")
	image := env("BOXLITE_E2E_IMAGE", "alpine:3.23")

	rt, err := boxlite.NewRest(boxlite.BoxliteRestOptions{
		URL:        url,
		Credential: boxlite.NewApiKeyCredential(apiKey),
		PathPrefix: prefix,
	})
	if err != nil {
		die("NewRest: %v", err)
	}
	defer rt.Close()

	ctx := context.Background()
	box, err := rt.Create(ctx, image, boxlite.WithAutoRemove(true))
	if err != nil {
		die("Create: %v", err)
	}
	fmt.Printf("BOX_ID=%s\n", box.ID())
	defer func() {
		_ = rt.Remove(ctx, box.ID())
	}()

	tmpDir, err := os.MkdirTemp("", "boxlite-go-e2e-")
	if err != nil {
		die("MkdirTemp: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	content := "hello-from-go-copy-e2e\n"
	uploadPath := filepath.Join(tmpDir, "upload.txt")
	downloadPath := filepath.Join(tmpDir, "download.txt")

	if err := os.WriteFile(uploadPath, []byte(content), 0644); err != nil {
		die("WriteFile: %v", err)
	}

	// copy in
	if err := box.CopyInto(ctx, uploadPath, "/tmp/e2e-copy-test.txt"); err != nil {
		die("CopyInto: %v", err)
	}

	// verify via exec
	result, err := box.Exec(ctx, "cat", "/tmp/e2e-copy-test.txt")
	if err != nil {
		die("Exec cat: %v", err)
	}
	if strings.TrimSpace(result.Stdout) != strings.TrimSpace(content) {
		die("content mismatch: got %q, want %q", result.Stdout, content)
	}

	// copy out
	if err := box.CopyOut(ctx, "/tmp/e2e-copy-test.txt", downloadPath); err != nil {
		die("CopyOut: %v", err)
	}
	downloaded, err := os.ReadFile(downloadPath)
	if err != nil {
		die("ReadFile: %v", err)
	}
	if strings.TrimSpace(string(downloaded)) != strings.TrimSpace(content) {
		die("copy out mismatch: got %q", string(downloaded))
	}

	fmt.Println("COPY_ROUNDTRIP=ok")
	fmt.Println("OK")
}
