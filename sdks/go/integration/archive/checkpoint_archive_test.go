//go:build boxlite_dev && boxlite_integration

package archive_test

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
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

func TestCheckpointNativeImportExport(t *testing.T) {
	rt, err := boxlite.NewRuntime(boxlite.WithHomeDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	ctx := context.Background()
	source := checkpointSourceFixture(t, "example.invalid/app@sha256:"+strings.Repeat("a", 64))
	original, err := rt.Import(ctx, source.Path, "original")
	if err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	archive, err := original.Export(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	imported, err := rt.Import(ctx, archive, "restored")
	if err != nil {
		t.Fatal(err)
	}
	defer imported.Close()
	info, err := imported.Info(ctx)
	if err != nil || info.State != boxlite.StateStopped || imported.ID() == original.ID() {
		t.Fatalf("native import contract: %#v %v", info, err)
	}
	if err := os.WriteFile(source.Path, []byte("invalid archive"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := rt.Import(ctx, source.Path, "failed"); err == nil {
		t.Fatal("invalid archive accepted")
	}
	if _, err := rt.GetInfo(ctx, original.ID()); err != nil {
		t.Fatalf("failed import affected original: %v", err)
	}
}
