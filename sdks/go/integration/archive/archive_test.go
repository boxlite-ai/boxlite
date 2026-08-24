//go:build boxlite_dev && boxlite_integration

package archive_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

const (
	archiveMarkerPath = "/root/boxlite-go-archive-marker"
	archiveMarker     = "boxlite-go-archive-marker"
)

type archiveRoundTripFixture struct {
	t                 *testing.T
	ctx               context.Context
	runtime           *boxlite.Runtime
	source            *boxlite.Box
	restored          *boxlite.Box
	sourceID          string
	restoredID        string
	archivePath       string
	runtimeIsShutdown bool
}

// TestIntegrationArchiveRoundTrip covers the public Go SDK path against a real
// VM. The test removes the caller-owned archive before starting the imported
// box, proving that the restored box is self-contained.
func TestIntegrationArchiveRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	fixture := newArchiveRoundTripFixture(t, ctx)
	fixture.createAndSeedSource()
	fixture.exportAndValidateArchive()
	fixture.importAndValidateRestored()
	fixture.removeArchiveAndValidateRestored()
	fixture.validatePostShutdownBehavior()
}

func newArchiveRoundTripFixture(t *testing.T, ctx context.Context) *archiveRoundTripFixture {
	t.Helper()

	runtime, err := boxlite.NewRuntime(boxlite.WithHomeDir(t.TempDir()))
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}

	fixture := &archiveRoundTripFixture{
		t:       t,
		ctx:     ctx,
		runtime: runtime,
	}
	t.Cleanup(fixture.cleanup)
	return fixture
}

func (f *archiveRoundTripFixture) cleanup() {
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cleanupCancel()

	if f.restoredID != "" && !f.runtimeIsShutdown {
		if err := f.runtime.ForceRemove(cleanupCtx, f.restoredID); err != nil {
			f.t.Errorf("ForceRemove restored box: %v", err)
		}
	}
	if f.sourceID != "" && !f.runtimeIsShutdown {
		if err := f.runtime.ForceRemove(cleanupCtx, f.sourceID); err != nil {
			f.t.Errorf("ForceRemove source box: %v", err)
		}
	}
	if f.restored != nil {
		if err := f.restored.Close(); err != nil {
			f.t.Errorf("Close restored box handle: %v", err)
		}
	}
	if f.source != nil {
		if err := f.source.Close(); err != nil {
			f.t.Errorf("Close source box handle: %v", err)
		}
	}
	if err := f.runtime.Close(); err != nil {
		f.t.Errorf("Close runtime: %v", err)
	}
}

func (f *archiveRoundTripFixture) createAndSeedSource() {
	f.t.Helper()

	source, err := f.runtime.Create(
		f.ctx,
		"ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0",
		boxlite.WithName("go-archive-source"),
		boxlite.WithCPUs(1),
		boxlite.WithMemory(512),
		boxlite.WithDiskSize(2),
		boxlite.WithAutoRemove(false),
	)
	f.source = source
	if err != nil {
		f.t.Fatalf("Create source box: %v", err)
	}
	f.sourceID = f.source.ID()
	if f.sourceID == "" {
		f.t.Fatal("source box ID is empty")
	}
	if err := f.source.Start(f.ctx); err != nil {
		f.t.Fatalf("Start source box: %v", err)
	}

	assertExec(
		f.t,
		f.source,
		f.ctx,
		"write durable source marker",
		archiveMarker,
		"/bin/sh",
		"-c",
		"sudo /bin/sh -c \"printf '"+archiveMarker+"' > "+archiveMarkerPath+" && sync\" && sudo /bin/cat "+archiveMarkerPath,
	)
}

func (f *archiveRoundTripFixture) exportAndValidateArchive() {
	f.t.Helper()

	archiveDir := f.t.TempDir()
	archivePath, err := f.source.Export(f.ctx, archiveDir)
	if err != nil {
		f.t.Fatalf("Export source box: %v", err)
	}
	f.archivePath = filepath.Clean(archivePath)
	if filepath.Dir(f.archivePath) != filepath.Clean(archiveDir) {
		f.t.Fatalf("Export path %q is outside destination %q", f.archivePath, archiveDir)
	}
	archiveInfo, err := os.Stat(f.archivePath)
	if err != nil {
		f.t.Fatalf("stat exported archive: %v", err)
	}
	if !archiveInfo.Mode().IsRegular() {
		f.t.Fatalf("exported archive %q is not a regular file", f.archivePath)
	}
	if archiveInfo.Size() == 0 {
		f.t.Fatalf("exported archive %q is empty", f.archivePath)
	}
	if filepath.Ext(f.archivePath) != ".boxlite" {
		f.t.Fatalf("exported archive %q does not use .boxlite extension", f.archivePath)
	}

	assertExec(
		f.t,
		f.source,
		f.ctx,
		"read source marker after Export",
		archiveMarker,
		"/bin/sh",
		"-c",
		"sudo /bin/cat "+archiveMarkerPath,
	)
	if err := f.source.Stop(f.ctx); err != nil {
		f.t.Fatalf("Stop source box: %v", err)
	}
}

func (f *archiveRoundTripFixture) importAndValidateRestored() {
	f.t.Helper()

	restored, err := f.runtime.Import(f.ctx, f.archivePath, "")
	f.restored = restored
	if err != nil {
		f.t.Fatalf("Import archive: %v", err)
	}
	f.restoredID = f.restored.ID()
	if f.restoredID == "" {
		f.t.Fatal("restored box ID is empty")
	}
	if f.restoredID == f.sourceID {
		f.t.Fatalf("Import reused source box ID %q", f.sourceID)
	}
	if f.restored.Name() != "" {
		f.t.Fatalf("restored handle name = %q, want unnamed", f.restored.Name())
	}

	restoredInfo, err := f.restored.Info(f.ctx)
	if err != nil {
		f.t.Fatalf("Info restored box: %v", err)
	}
	if restoredInfo.Name != "" {
		f.t.Fatalf("restored persisted name = %q, want unnamed", restoredInfo.Name)
	}
	if restoredInfo.State != boxlite.StateStopped || restoredInfo.Running {
		f.t.Fatalf(
			"restored state = %q running=%v, want stopped",
			restoredInfo.State,
			restoredInfo.Running,
		)
	}

	if _, err := os.Stat(f.archivePath); err != nil {
		f.t.Fatalf("Import removed caller-owned archive: %v", err)
	}
}

func (f *archiveRoundTripFixture) removeArchiveAndValidateRestored() {
	f.t.Helper()

	if err := os.Remove(f.archivePath); err != nil {
		f.t.Fatalf("caller remove archive: %v", err)
	}
	if _, err := os.Stat(f.archivePath); !os.IsNotExist(err) {
		f.t.Fatalf("archive still exists after caller removal: %v", err)
	}

	if err := f.restored.Start(f.ctx); err != nil {
		f.t.Fatalf("Start restored box after archive deletion: %v", err)
	}
	assertExec(
		f.t,
		f.restored,
		f.ctx,
		"read restored durable marker",
		archiveMarker,
		"/bin/sh",
		"-c",
		"sudo /bin/cat "+archiveMarkerPath,
	)

	const writableMarker = "restored-box-remains-writable"
	assertExec(
		f.t,
		f.restored,
		f.ctx,
		"write and read restored box",
		writableMarker,
		"/bin/sh",
		"-c",
		"sudo /bin/sh -c \"printf '"+writableMarker+"' > /root/restored-writable\" && sudo /bin/cat /root/restored-writable",
	)
}

func (f *archiveRoundTripFixture) validatePostShutdownBehavior() {
	f.t.Helper()

	if err := f.runtime.Shutdown(f.ctx, 2*time.Minute); err != nil {
		f.t.Fatalf("Shutdown runtime: %v", err)
	}
	f.runtimeIsShutdown = true

	postShutdownArchive, err := f.restored.Export(f.ctx, f.t.TempDir())
	if err != nil {
		f.t.Fatalf("Export after Shutdown: %v", err)
	}
	postShutdownInfo, err := os.Stat(postShutdownArchive)
	if err != nil {
		f.t.Fatalf("stat post-Shutdown archive: %v", err)
	}
	if !postShutdownInfo.Mode().IsRegular() || postShutdownInfo.Size() == 0 {
		f.t.Fatalf("post-Shutdown archive is not a non-empty regular file: %+v", postShutdownInfo)
	}

	unexpected, err := f.runtime.Import(f.ctx, postShutdownArchive, "")
	if unexpected != nil {
		_ = unexpected.Close()
		f.t.Fatal("Import after Shutdown returned a box")
	}
	if !boxlite.IsStopped(err) {
		f.t.Fatalf("Import after Shutdown error = %v, want stopped", err)
	}
}

func assertExec(
	t *testing.T,
	box *boxlite.Box,
	ctx context.Context,
	operation string,
	wantStdout string,
	command string,
	args ...string,
) {
	t.Helper()

	result, err := box.Exec(ctx, command, args...)
	if err != nil {
		t.Fatalf("%s: %v", operation, err)
	}
	if result == nil {
		t.Fatalf("%s returned nil result", operation)
	}
	if result.ExitCode != 0 {
		t.Fatalf(
			"%s exit code = %d, want 0; stderr=%q",
			operation,
			result.ExitCode,
			result.Stderr,
		)
	}
	if result.Stdout != wantStdout {
		t.Fatalf("%s stdout = %q, want %q", operation, result.Stdout, wantStdout)
	}
}
