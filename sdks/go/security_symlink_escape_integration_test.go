//go:build boxlite_dev

// Regression test for GHSA-f396-4rp4-7v2j (OCI layer symlink escape).
//
// A crafted OCI layer with a symlink pointing outside the extraction root
// followed by a file entry that resolves through that symlink must NOT
// write to the host. The v0.9.0 fix enforces this via SafeRoot containment
// in the Rust extractor; this test exercises the same defense through the
// Go SDK by loading a malicious local OCI layout via WithRootfsPath.
//
// Go-SDK counterpart of:
//   - sdks/python/tests/test_symlink_escape.py
//   - sdks/node/tests/security-symlink-escape.integration.test.ts
//   - src/boxlite/src/images/archive/extractor.rs::test_cve_symlink_escape_blocked
package boxlite

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const symlinkEscapeTarget = "/tmp/boxlite_host_escape_go/pwned.txt"

func writeBlob(t *testing.T, blobsDir string, data []byte) (string, int) {
	t.Helper()
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if err := os.WriteFile(filepath.Join(blobsDir, digest), data, 0o644); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	return digest, len(data)
}

func buildMaliciousLayerTar(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	mtime := time.Now()

	writeHeader := func(hdr *tar.Header, body []byte) {
		hdr.ModTime = mtime
		if body != nil {
			hdr.Size = int64(len(body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("tar header: %v", err)
		}
		if body != nil {
			if _, err := tw.Write(body); err != nil {
				t.Fatalf("tar body: %v", err)
			}
		}
	}

	// (1) Symlink: escape -> /tmp
	writeHeader(&tar.Header{
		Name:     "escape",
		Mode:     0o777,
		Typeflag: tar.TypeSymlink,
		Linkname: "/tmp",
	}, nil)

	// (2) Dir under the symlink — resolves to /tmp/boxlite_host_escape_go/
	writeHeader(&tar.Header{
		Name:     "escape/boxlite_host_escape_go",
		Mode:     0o755,
		Typeflag: tar.TypeDir,
	}, nil)

	// (3) Payload file at the escape target.
	payload := []byte(fmt.Sprintf("===== BOXLITE GO SDK SYMLINK ESCAPE PoC =====\nTarget: %s\n", symlinkEscapeTarget))
	writeHeader(&tar.Header{
		Name:     "escape/boxlite_host_escape_go/pwned.txt",
		Mode:     0o644,
		Typeflag: tar.TypeReg,
	}, payload)

	// (4) Decoy legit entry.
	writeHeader(&tar.Header{
		Name:     "etc/os-release",
		Mode:     0o644,
		Typeflag: tar.TypeReg,
	}, []byte("ID=alpine\nVERSION_ID=3.19.0\n"))

	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	return buf.Bytes()
}

func buildMaliciousOciLayout(t *testing.T, dir string) {
	t.Helper()
	blobsDir := filepath.Join(dir, "blobs", "sha256")
	if err := os.MkdirAll(blobsDir, 0o755); err != nil {
		t.Fatalf("mkdir blobs: %v", err)
	}

	layer := buildMaliciousLayerTar(t)
	layerDigest, layerSize := writeBlob(t, blobsDir, layer)

	cfg, err := json.Marshal(map[string]any{
		"architecture": "amd64",
		"os":           "linux",
		"config":       map[string]any{"Cmd": []string{"/bin/sh"}},
		"rootfs": map[string]any{
			"type":     "layers",
			"diff_ids": []string{"sha256:" + layerDigest},
		},
	})
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	cfgDigest, cfgSize := writeBlob(t, blobsDir, cfg)

	mf, err := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"mediaType":     "application/vnd.oci.image.manifest.v1+json",
		"config": map[string]any{
			"mediaType": "application/vnd.oci.image.config.v1+json",
			"digest":    "sha256:" + cfgDigest,
			"size":      cfgSize,
		},
		"layers": []map[string]any{{
			"mediaType": "application/vnd.oci.image.layer.v1.tar",
			"digest":    "sha256:" + layerDigest,
			"size":      layerSize,
		}},
	})
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	mfDigest, mfSize := writeBlob(t, blobsDir, mf)

	idx, err := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"manifests": []map[string]any{{
			"mediaType":   "application/vnd.oci.image.manifest.v1+json",
			"digest":      "sha256:" + mfDigest,
			"size":        mfSize,
			"annotations": map[string]string{"org.opencontainers.image.ref.name": "latest"},
		}},
	})
	if err != nil {
		t.Fatalf("marshal index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.json"), idx, 0o644); err != nil {
		t.Fatalf("write index.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "oci-layout"), []byte(`{"imageLayoutVersion":"1.0.0"}`), 0o644); err != nil {
		t.Fatalf("write oci-layout: %v", err)
	}
}

func TestSecuritySymlinkEscapeBlocked(t *testing.T) {
	// Pre-clean any state from a previous run.
	_ = os.RemoveAll("/tmp/boxlite_host_escape_go")

	layoutDir, err := os.MkdirTemp("/tmp", "malicious-oci-go-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(layoutDir) })

	buildMaliciousOciLayout(t, layoutDir)

	if _, err := os.Stat(symlinkEscapeTarget); err == nil {
		t.Fatalf("host file must not exist before exploit attempt: %s", symlinkEscapeTarget)
	}

	rt := newTestRuntime(t)
	ctx := context.Background()

	// The image arg is required by Create signature, but WithRootfsPath
	// takes precedence per options.go:132.
	box, err := rt.Create(ctx, "alpine:latest",
		WithAutoRemove(false),
		WithRootfsPath(layoutDir),
	)
	if err != nil {
		// Create may legitimately fail on incomplete rootfs after the
		// extractor refuses the escape — that's fine; the vulnerability
		// would fire during extraction, before VM launch.
		var e *Error
		if errors.As(err, &e) {
			t.Logf("Create returned error (acceptable): %v", err)
		}
	} else {
		t.Cleanup(func() {
			_ = box.Stop(ctx)
			_ = rt.ForceRemove(ctx, box.ID())
			_ = box.Close()
		})
		// Best-effort start; failures are also acceptable since the
		// extraction has already completed (or been refused).
		if err := box.Start(ctx); err == nil {
			_, _ = box.Exec(ctx, "sh", "-c", "echo ok")
		} else {
			t.Logf("Start returned error (acceptable): %v", err)
		}
	}

	// The advisory's own exploit oracle.
	if _, err := os.Stat(symlinkEscapeTarget); err == nil {
		t.Fatalf("GHSA-f396-4rp4-7v2j: host file written via escape symlink at %s — SafeRoot containment failed", symlinkEscapeTarget)
	}
}
