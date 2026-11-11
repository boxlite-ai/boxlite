//go:build boxlite_dev && boxlite_integration

package archive_test

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

type archiveSource struct{ Path, SHA256, PinnedImage string }

func (f *preparedImportFixture) prepare(ctx context.Context) (*boxlite.PreparedImport, error) {
	target := "target"
	return f.runtime.PrepareImport(ctx, f.source.Path, boxlite.ImportOptions{
		Image: f.source.PinnedImage, Env: map[string]*string{"BOXLITE_BOX_ID": &target}, PreflightStartup: true,
	})
}

type preparedImportFixture struct {
	runtime  *boxlite.Runtime
	registry *httptest.Server
	home     string
	source   archiveSource
	started  chan struct{}
	release  chan struct{}
	once     sync.Once
	configs  atomic.Int32
}

// The real local runtime pulls from this loopback OCI registry. Blocking its
// manifest response lets cancellation precede native completion without timing
// assumptions; Rust already owns validated staging when the request arrives.
func newPreparedImportFixture(t *testing.T) *preparedImportFixture {
	t.Helper()
	// Exercise the loopback registry directly even when the developer uses an
	// HTTP proxy for unrelated image pulls.
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	f := &preparedImportFixture{home: t.TempDir(), started: make(chan struct{}), release: make(chan struct{})}
	config := []byte(`{"architecture":"amd64","os":"linux","config":{"Env":["IMAGE_DEFAULT=keep"]},"rootfs":{"type":"layers","diff_ids":[]}}`)
	manifest, err := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"mediaType":     "application/vnd.oci.image.manifest.v1+json",
		"config":        map[string]any{"mediaType": "application/vnd.oci.image.config.v1+json", "digest": "sha256:" + checkpointDigest(config), "size": len(config)},
		"layers":        []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	var arrived sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v2/" || r.URL.Path == "/v2":
			w.WriteHeader(http.StatusOK)
		case strings.HasPrefix(r.URL.Path, "/v2/checkpoint/app/manifests/"):
			arrived.Do(func() { close(f.started) })
			select {
			case <-f.release:
			case <-r.Context().Done():
				return
			}
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
			w.Header().Set("Docker-Content-Digest", "sha256:"+checkpointDigest(manifest))
			_, _ = w.Write(manifest)
		case r.URL.Path == "/v2/checkpoint/app/blobs/sha256:"+checkpointDigest(config):
			f.configs.Add(1)
			w.Header().Set("Content-Type", "application/vnd.oci.image.config.v1+json")
			_, _ = w.Write(config)
		default:
			http.NotFound(w, r)
		}
	}))
	f.registry = server
	t.Cleanup(func() { f.unblock(); server.Close() })
	host := strings.TrimPrefix(server.URL, "http://")
	f.runtime, err = boxlite.NewRuntime(boxlite.WithHomeDir(f.home), boxlite.WithImageRegistry(boxlite.ImageRegistry{Host: host, Transport: boxlite.RegistryTransportHTTP}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.unblock(); _ = f.runtime.Close() })
	image := host + "/checkpoint/app@sha256:" + checkpointDigest(manifest)
	f.source = checkpointSourceFixture(t, image)
	return f
}

func (f *preparedImportFixture) unblock() { f.once.Do(func() { close(f.release) }) }

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
			"rootfs": map[string]string{"Image": image}, "cpus": 1, "memory_mib": 128,
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

func TestPreparedImportCommitsStagingWithoutSourceAndOnlyOnce(t *testing.T) {
	f := newPreparedImportFixture(t)
	f.unblock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	prepared, err := f.prepare(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Close()
	info, err := prepared.Info()
	if err != nil || info.Version != 3 || !info.HasDiskChecksum || !strings.Contains(string(info.BoxOptions), "source") {
		t.Fatalf("source metadata: %#v %v", info, err)
	}
	if f.configs.Load() == 0 {
		t.Fatal("preflight did not fetch OCI config")
	}
	if boxes, err := f.runtime.ListInfo(ctx); err != nil || len(boxes) != 0 {
		t.Fatalf("preparation created boxes: %v %v", boxes, err)
	}
	if _, err := prepared.Commit(ctx, "bad\x00name"); !boxlite.IsInvalidArgument(err) {
		t.Fatalf("invalid name: %v", err)
	}
	rejected, stop := context.WithCancel(ctx)
	stop()
	if _, err := prepared.Commit(rejected, "target"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled admission: %v", err)
	}
	if _, err := prepared.Info(); err != nil {
		t.Fatalf("rejection consumed staging: %v", err)
	}
	assertCheckpointSourceUnchanged(t, f.source)
	if err := os.Remove(f.source.Path); err != nil {
		t.Fatal(err)
	}
	imported, err := prepared.Commit(ctx, "target")
	if err != nil {
		t.Fatalf("commit depended on removed source: %v", err)
	}
	defer imported.Close()
	if _, err := prepared.Commit(ctx, "duplicate"); err == nil {
		t.Fatal("owner committed twice")
	}
	if err := prepared.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := prepared.Info(); err == nil {
		t.Fatal("closed owner exposes native pointer")
	}
	accepted, err := f.runtime.GetInfo(ctx, "target")
	if err != nil || accepted.ID != imported.ID() || accepted.State != boxlite.StateStopped || accepted.CPUs != 1 || accepted.MemoryMiB != 128 {
		t.Fatalf("commit or Close lost the accepted box: %#v %v", accepted, err)
	}
}

func TestPreparedImportConcurrentCommitAndClose(t *testing.T) {
	f := newPreparedImportFixture(t)
	f.unblock()
	for attempt := 0; attempt < 8; attempt++ {
		prepared, err := f.prepare(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan *boxlite.Box, 2)
		var workers sync.WaitGroup
		for range 2 {
			workers.Add(1)
			go func() {
				defer workers.Done()
				<-start
				imported, err := prepared.Commit(t.Context(), "")
				if err == nil && imported == nil {
					t.Error("successful commit returned no box")
				}
				results <- imported
			}()
		}
		workers.Add(1)
		go func() { defer workers.Done(); <-start; _ = prepared.Close() }()
		close(start)
		workers.Wait()
		close(results)
		accepted := 0
		for imported := range results {
			if imported != nil {
				accepted++
				if _, err := imported.Info(t.Context()); err != nil {
					t.Fatalf("concurrent Close invalidated committed box: %v", err)
				}
				_ = imported.Close()
			}
		}
		if accepted > 1 {
			t.Fatalf("staging committed %d times", accepted)
		}
		if _, err := prepared.Commit(t.Context(), "retry"); err == nil {
			t.Fatal("closed/consumed owner accepted retry")
		}
	}
}

func TestPreparedImportCancellationDisposesLateNativeSuccess(t *testing.T) {
	f := newPreparedImportFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		prepared, err := f.prepare(ctx)
		if prepared != nil {
			_ = prepared.Close()
			finished <- errors.New("canceled preparation returned an owner")
			return
		}
		finished <- err
	}()
	select {
	case <-f.started:
	case err := <-finished:
		t.Fatalf("preparation finished before native registry request: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("native preparation never reached OCI preflight")
	}
	var derived string
	if err := filepath.WalkDir(filepath.Join(f.home, "tmp"), func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.Name() == "disk.qcow2" {
			derived = path
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if derived == "" {
		t.Fatal("accepted operation has no retained staging disk")
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled caller: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled caller waited for native OCI completion")
	}
	if _, err := os.Stat(derived); err != nil {
		t.Fatalf("cancellation released files still owned by native work: %v", err)
	}
	f.unblock()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(derived); errors.Is(err, os.ErrNotExist) {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("late native completion leaked its prepared archive owner")
		}
	}
	// Disconnect the registry: only the first accepted native pull could have
	// cached this build. A second successful preparation proves that late
	// cleanup was not merely caused by an invalid registry fixture.
	f.registry.Close()
	if f.configs.Load() == 0 {
		t.Fatal("accepted native preparation never downloaded the OCI config")
	}
	verify, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	prepared, err := f.prepare(verify)
	if err != nil {
		t.Fatal(err)
	}
	if err := prepared.Close(); err != nil {
		t.Fatal(err)
	}
	assertCheckpointSourceUnchanged(t, f.source)
}

func TestPreparedImportOwnerSurvivesRuntimeCloseForCleanup(t *testing.T) {
	f := newPreparedImportFixture(t)
	f.unblock()
	prepared, err := f.prepare(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := f.runtime.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := prepared.Commit(t.Context(), "closed"); !errors.Is(err, boxlite.ErrRuntimeClosed) {
		t.Fatalf("commit after runtime close: %v", err)
	}
	if err := prepared.Close(); err != nil {
		t.Fatal(err)
	}
	assertCheckpointSourceUnchanged(t, f.source)
}

func assertCheckpointSourceUnchanged(t *testing.T, source archiveSource) {
	t.Helper()
	data, err := os.ReadFile(source.Path)
	if err != nil {
		t.Fatal(err)
	}
	if checkpointDigest(data) != source.SHA256 {
		t.Fatal("prepared owner cleanup changed the immutable source archive")
	}
}
