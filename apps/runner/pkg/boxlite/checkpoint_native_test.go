//go:build boxlite_dev && boxlite_integration

package boxlite

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"
)

type archiveSource struct{ Path, SHA256, PinnedImage string }

func checkpointDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func checkpointSourceFixture(t *testing.T, image string) archiveSource {
	t.Helper()
	// Empty standalone QCOW2 v2: header, refcount table, refcount block and L1
	// occupy four clusters; no guest data is allocated. This tests the archive
	// adapter without a VM. Format: https://www.qemu.org/docs/master/interop/qcow2.html
	const cluster = 1 << 16
	disk := make([]byte, 4*cluster)
	binary.BigEndian.PutUint32(disk[0:4], 0x514649fb)
	binary.BigEndian.PutUint32(disk[4:8], 2)
	binary.BigEndian.PutUint32(disk[20:24], 16)
	binary.BigEndian.PutUint64(disk[24:32], 1<<20)
	binary.BigEndian.PutUint32(disk[36:40], 1)
	binary.BigEndian.PutUint64(disk[40:48], 3*cluster)
	binary.BigEndian.PutUint64(disk[48:56], cluster)
	binary.BigEndian.PutUint32(disk[56:60], 1)
	binary.BigEndian.PutUint64(disk[cluster:cluster+8], 2*cluster)
	for i := 0; i < 4; i++ {
		binary.BigEndian.PutUint16(disk[2*cluster+2*i:], 1)
	}
	manifest, err := json.Marshal(map[string]any{
		"version": 3, "box_name": "source", "image": image,
		"box_options": map[string]any{
			"rootfs": map[string]string{"Image": image}, "cpus": 1, "memory_mib": 256,
			"env":    [][2]string{{"APP_MODE", "captured"}, {"BOXLITE_BOX_ID", "source"}},
			"detach": true, "auto_delete": 0,
		},
		"guest_disk_checksum": "", "container_disk_checksum": "sha256:" + checkpointDigest(disk),
		"exported_at": time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "source.boxlite")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	for _, member := range []struct {
		name string
		data []byte
	}{{"manifest.json", manifest}, {"disk.qcow2", disk}} {
		if err := writer.WriteHeader(&tar.Header{Name: member.name, Mode: 0600, Size: int64(len(member.data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(member.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return archiveSource{Path: path, SHA256: checkpointDigest(data), PinnedImage: image}
}

type nativeArchiveStore struct {
	data      []byte
	downloads int
}

func (s *nativeArchiveStore) Upload(context.Context, string, string) error {
	return fmt.Errorf("unexpected upload")
}
func (s *nativeArchiveStore) Remove(context.Context, string) error {
	return fmt.Errorf("unexpected removal")
}
func (s *nativeArchiveStore) Download(_ context.Context, _ string, path string) error {
	s.downloads++
	return os.WriteFile(path, s.data, 0600)
}

func TestCheckpointNativeRestoreKeepsFailedImportAndPersistsReplacement(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	for _, corrupt := range []bool{true, false} {
		t.Run(fmt.Sprint(corrupt), func(t *testing.T) {
			ctx := context.Background()
			home := t.TempDir()
			rt, err := sdk.NewRuntime(sdk.WithHomeDir(home))
			if err != nil {
				t.Fatal(err)
			}
			client := &Client{runtime: rt, homeDir: home, boxes: make(map[string]*sdk.Box), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			t.Cleanup(func() { _ = client.Close() })
			target := uuid.NewString()
			image := "example.invalid/app@sha256:" + strings.Repeat("a", 64)
			seed := checkpointSourceFixture(t, image)
			original, err := rt.Import(ctx, seed.Path, target)
			if err != nil {
				t.Fatal(err)
			}
			originalID := original.ID()
			artifacts := checkpoint.Artifacts{Root: filepath.Join(home, "work", "archives")}
			ref := checkpoint.Reference{CheckpointID: uuid.NewString(), ExportJobID: uuid.NewString(), SourceBoxID: target, ArcPath: "gs://archives/" + uuid.NewString() + ".boxlite"}
			store := &nativeArchiveStore{}
			artifact, err := artifacts.Export(ctx, ref, func(ctx context.Context, dir string) (string, string, error) {
				path, err := original.Export(ctx, dir)
				if err != nil {
					return "", "", err
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return "", "", err
				}
				if corrupt {
					decoder, err := zstd.NewReader(nil)
					if err != nil {
						return "", "", err
					}
					raw, err := decoder.DecodeAll(data, nil)
					decoder.Close()
					if err != nil {
						return "", "", err
					}
					reader := tar.NewReader(bytes.NewReader(raw))
					if _, err := reader.Next(); err != nil {
						return "", "", err
					}
					manifest, err := io.ReadAll(reader)
					if err != nil {
						return "", "", err
					}
					var metadata struct {
						Checksum string `json:"container_disk_checksum"`
					}
					if err := json.Unmarshal(manifest, &metadata); err != nil {
						return "", "", err
					}
					raw = bytes.Replace(raw, []byte(metadata.Checksum), []byte("sha256:"+strings.Repeat("0", 64)), 1)
					encoder, err := zstd.NewWriter(nil)
					if err != nil {
						return "", "", err
					}
					data = encoder.EncodeAll(raw, nil)
					encoder.Close()
					if err := os.WriteFile(path, data, 0600); err != nil {
						return "", "", err
					}
				}
				store.data = data
				return path, image, nil
			})
			original.Close()
			if err != nil {
				t.Fatal(err)
			}
			request := checkpoint.RestoreRequest{OperationID: uuid.NewString(), Sequence: 1, Target: target, Mode: "recover", Archive: artifact, PlatformEnv: map[string]string{"BOXLITE_BOX_ID": target}}
			result, err := client.RestoreCheckpoint(ctx, request, uuid.NewString(), artifacts, store)
			if corrupt {
				if err == nil {
					t.Fatal("native disk checksum failure was hidden")
				}
				info, lookupErr := client.nativeBoxInfo(ctx, target)
				if lookupErr != nil || info.ID != originalID {
					t.Fatalf("failed import changed original: %#v %v", info, lookupErr)
				}
				if _, err := rt.GetInfo(ctx, originalID); err != nil {
					t.Fatalf("old box removed: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := rt.GetInfo(ctx, originalID); !sdk.IsNotFound(err) {
				t.Fatalf("old box retained after success: %v", err)
			}
			info, err := client.nativeBoxInfo(ctx, target)
			if err != nil || info.ID != result.NativeID || info.Name != target {
				t.Fatalf("published lookup: %#v %v", info, err)
			}
			boxes, err := client.ListInfo(ctx)
			if err != nil || len(boxes) != 1 || boxes[0].Name != target || boxes[0].ID != result.NativeID {
				t.Fatalf("public inventory: %#v %v", boxes, err)
			}
			if _, err := client.getOrFetchBox(ctx, target); err != nil {
				t.Fatal(err)
			}
			if err := client.Close(); err != nil {
				t.Fatal(err)
			}
			rt, err = sdk.NewRuntime(sdk.WithHomeDir(home))
			if err != nil {
				t.Fatal(err)
			}
			client = &Client{runtime: rt, homeDir: home, boxes: make(map[string]*sdk.Box), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			info, err = client.nativeBoxInfo(ctx, target)
			if err != nil || info.ID != result.NativeID {
				t.Fatalf("restart lost mapping: %#v %v", info, err)
			}
			replay, err := client.RestoreCheckpoint(ctx, request, uuid.NewString(), artifacts, store)
			if err != nil || replay.NativeID != result.NativeID || store.downloads != 1 {
				t.Fatalf("replay imported again: %#v %v downloads=%d", replay, err, store.downloads)
			}
			request.OperationID, request.Sequence = uuid.NewString(), 2
			second, err := client.RestoreCheckpoint(ctx, request, uuid.NewString(), artifacts, store)
			if err != nil || second.NativeID == result.NativeID {
				t.Fatalf("second replacement: %#v %v", second, err)
			}
			if _, err := rt.GetInfo(ctx, result.NativeID); !sdk.IsNotFound(err) {
				t.Fatalf("previous candidate retained: %v", err)
			}
			if err := client.RetireCheckpointTarget(ctx, target); err != nil {
				t.Fatal(err)
			}
			if err := client.Destroy(ctx, target); err != nil {
				t.Fatal(err)
			}
			boxes, err = client.ListInfo(ctx)
			if err != nil || len(boxes) != 0 {
				t.Fatalf("destroy did not resolve mapping: %#v %v", boxes, err)
			}
		})
	}
}
