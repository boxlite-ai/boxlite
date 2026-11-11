// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/klauspost/compress/zstd"
)

func TestCheckpointImportManifestReplacesOnlyCloudIdentity(t *testing.T) {
	source := []byte(`{"version":6,"image":"example/app:old","container_disk_checksum":"original","future":"keep","box_options":{"rootfs":{"Image":"example/app:old"},"cpus":1.5,"env":[["APP_MODE","captured"],["BOXLITE_BOX_ID","source"],["BOXLITE_TRACEPARENT","old"]]}}`)
	image := "example/app:old@sha256:" + strings.Repeat("a", 64)
	env := map[string]string{"BOXLITE_BOX_ID": "target", "BOXLITE_ORGANIZATION_ID": "org"}
	data, err := checkpointImportManifest(source, image, env)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version  int    `json:"version"`
		Image    string `json:"image"`
		Checksum string `json:"container_disk_checksum"`
		Future   string `json:"future"`
		Options  struct {
			CPUs   float64           `json:"cpus"`
			Env    [][2]string       `json:"env"`
			Rootfs map[string]string `json:"rootfs"`
		} `json:"box_options"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Image != "example/app@sha256:"+strings.Repeat("a", 64) || manifest.Options.Rootfs["Image"] != manifest.Image || manifest.Version != 6 || manifest.Checksum != "original" || manifest.Future != "keep" || manifest.Options.CPUs != 1.5 {
		t.Fatalf("unrelated archive settings changed: %s", data)
	}
	variables := map[string]string{}
	for _, pair := range manifest.Options.Env {
		variables[pair[0]] = pair[1]
	}
	if len(variables) != 3 || variables["APP_MODE"] != "captured" || variables["BOXLITE_BOX_ID"] != "target" || variables["BOXLITE_ORGANIZATION_ID"] != "org" {
		t.Fatalf("source identity survived: %#v", variables)
	}
	for _, candidate := range []map[string]string{{}, {"BOXLITE_BOX_ID": "target", "USER_CONFIG": "override"}, {"BOXLITE_BOX_ID": "target\x00invalid"}} {
		if _, err := checkpointImportManifest(source, image, candidate); err == nil {
			t.Fatal("invalid platform environment accepted")
		}
	}
	for _, data := range [][]byte{[]byte("{"), []byte(`{"box_options":null}`), []byte(`{"box_options":{"env":false}}`)} {
		if _, err := checkpointImportManifest(data, image, env); err == nil {
			t.Fatal("uneditable manifest accepted")
		}
	}
	if _, err := checkpointImportManifest(source, "example/app:moved", env); err == nil {
		t.Fatal("mutable image accepted")
	}
}

func TestCheckpointImportCopiesTheOriginalTarTail(t *testing.T) {
	for _, compressed := range []bool{false, true} {
		t.Run(map[bool]string{false: "tar", true: "zstd"}[compressed], func(t *testing.T) {
			var original bytes.Buffer
			writer := tar.NewWriter(&original)
			manifest := []byte(`{"version":3,"image":"alpine:old","box_options":{"env":[],"rootfs":{"Image":"alpine:old"}}}`)
			if err := writer.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0600, Size: int64(len(manifest))}); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write(manifest); err != nil {
				t.Fatal(err)
			}
			if err := writer.WriteHeader(&tar.Header{Name: "disk.qcow2", Mode: 0600, Size: 4}); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write([]byte("disk")); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			tail := append([]byte(nil), original.Bytes()[1024:]...)
			data := original.Bytes()
			if compressed {
				encoder, err := zstd.NewWriter(nil)
				if err != nil {
					t.Fatal(err)
				}
				data = encoder.EncodeAll(data, nil)
				encoder.Close()
			}
			path := filepath.Join(t.TempDir(), "source.boxlite")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			source := &checkpoint.DownloadedArchive{Path: path, Artifact: checkpoint.Artifact{PinnedImage: "alpine@sha256:" + strings.Repeat("a", 64)}}
			adapted, err := checkpointImportArchive(source, map[string]string{"BOXLITE_BOX_ID": "target"})
			if err != nil {
				t.Fatal(err)
			}
			file, err := os.Open(adapted)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			reader := tar.NewReader(file)
			header, err := reader.Next()
			if err != nil || header.Name != "manifest.json" {
				t.Fatalf("adapted manifest: %#v %v", header, err)
			}
			if _, err := io.Copy(io.Discard, reader); err != nil {
				t.Fatal(err)
			}
			if _, err := file.Seek(512+(header.Size+511)/512*512, io.SeekStart); err != nil {
				t.Fatal(err)
			}
			copied, err := io.ReadAll(file)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(copied, tail) {
				t.Fatal("disk tar bytes were re-encoded")
			}
			retained, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(retained, data) {
				t.Fatal("source archive changed")
			}
		})
	}
}

func TestCheckpointImportArchiveRejectsDamagedPrefixAndCleansPartialOutput(t *testing.T) {
	manifest := []byte(`{"box_options":{"env":[]}}`)
	prefix := func(name string, size int64, data []byte) []byte {
		var buffer bytes.Buffer
		writer := tar.NewWriter(&buffer)
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: size}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(data); err != nil {
			t.Fatal(err)
		}
		if int64(len(data)) == size {
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
		}
		return buffer.Bytes()
	}
	valid := prefix("manifest.json", int64(len(manifest)), manifest)
	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	// The first frame yields a complete manifest; the next frame fails only
	// after the adapter has created its output and starts copying the disk tail.
	damagedTail := append(encoder.EncodeAll(valid[:1024], nil), []byte("broken-zstd-frame")...)
	cases := map[string][]byte{
		"short magic":             {1, 2, 3},
		"short header":            []byte("incomplete tar"),
		"invalid header":          bytes.Repeat([]byte{1}, 512),
		"wrong first member":      prefix("disk.qcow2", 0, nil),
		"oversized manifest":      prefix("manifest.json", (1<<20)+1, nil),
		"truncated manifest":      prefix("manifest.json", 20, []byte("{}")),
		"truncated padding":       valid[:512+len(manifest)],
		"invalid manifest":        prefix("manifest.json", 1, []byte("{")),
		"damaged compressed tail": damagedTail,
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "source.boxlite")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			source := &checkpoint.DownloadedArchive{Path: path, Artifact: checkpoint.Artifact{PinnedImage: "alpine@sha256:" + strings.Repeat("a", 64)}}
			if output, err := checkpointImportArchive(source, map[string]string{"BOXLITE_BOX_ID": "target"}); err == nil || output != "" {
				t.Fatalf("damaged archive accepted: %q %v", output, err)
			}
			files, err := filepath.Glob(filepath.Join(dir, "import-*.tar"))
			if err != nil || len(files) != 0 {
				t.Fatalf("partial output retained: %v %v", files, err)
			}
			retained, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(retained, data) {
				t.Fatal("failed adaptation modified the source")
			}
		})
	}
	source := &checkpoint.DownloadedArchive{Path: filepath.Join(t.TempDir(), "missing.boxlite")}
	if _, err := checkpointImportArchive(source, nil); !os.IsNotExist(err) {
		t.Fatalf("missing source: %v", err)
	}
}
