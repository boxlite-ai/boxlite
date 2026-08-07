package boxlite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/cgo"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var (
	_ interface {
		Export(context.Context, string) (string, error)
	} = (*Box)(nil)

	_ interface {
		Import(context.Context, string, string) (*Box, error)
	} = (*Runtime)(nil)
)

type archiveImportResult struct {
	box *Box
	err error
}

type archiveExportResult struct {
	path string
	err  error
}

// cancelBetweenErrChecksContext pauses after caching the first Err result.
// Canceling the wrapped context while paused makes the API's second Err check
// deterministically observe cancellation before native submission.
type cancelBetweenErrChecksContext struct {
	context.Context
	once    sync.Once
	sampled chan struct{}
	resume  <-chan struct{}
}

func (c *cancelBetweenErrChecksContext) Err() error {
	err := c.Context.Err()
	c.once.Do(func() {
		close(c.sampled)
		<-c.resume
	})
	return err
}

func TestAbandonOwnedResultCancelClaimsBeforeCallback(t *testing.T) {
	result := make(chan handleResult[*int], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	payload := new(int)
	*payload = 42

	var disposeCount atomic.Int32
	disposed := make(chan *int, 1)
	dispose := func(value *int) {
		disposeCount.Add(1)
		disposed <- value
	}

	abandonOwnedResult(result, handle, dispose)
	if claimOrFreePayload(handle, &payload, func(value **int) {
		dispose(*value)
	}) {
		t.Fatal("late callback claimed an abandoned handle")
	}

	select {
	case got := <-disposed:
		if got != payload {
			t.Fatal("disposed a different payload")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for late callback payload disposal")
	}
	if got := disposeCount.Load(); got != 1 {
		t.Fatalf("dispose count = %d, want 1", got)
	}
}

func TestAbandonOwnedResultDrainsCallbackOwnedPayload(t *testing.T) {
	result := make(chan handleResult[*int], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	payload := new(int)
	*payload = 42

	if !claimOrFreePayload(handle, &payload, func(_ **int) {
		t.Fatal("callback unexpectedly lost handle ownership")
	}) {
		t.Fatal("callback did not claim handle ownership")
	}
	handleNeedsDelete := true
	defer func() {
		if handleNeedsDelete {
			handle.Delete()
		}
	}()

	var disposeCount atomic.Int32
	disposed := make(chan *int, 1)
	abandonOwnedResult(result, handle, func(value *int) {
		disposeCount.Add(1)
		disposed <- value
	})
	result <- handleResult[*int]{value: payload, err: errors.New("native error")}
	handle.Delete()
	handleNeedsDelete = false

	select {
	case got := <-disposed:
		if got != payload {
			t.Fatal("disposed a different payload")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for callback-owned payload disposal")
	}
	if got := disposeCount.Load(); got != 1 {
		t.Fatalf("dispose count = %d, want 1", got)
	}
}

func TestArchiveArgumentValidation(t *testing.T) {
	runtime := &Runtime{}
	box := &Box{runtime: runtime}
	tests := []struct {
		name      string
		parameter string
		call      func() error
	}{
		{
			name:      "empty export destination",
			parameter: "export destination",
			call: func() error {
				_, err := box.Export(context.Background(), "")
				return err
			},
		},
		{
			name:      "NUL export destination",
			parameter: "export destination",
			call: func() error {
				_, err := box.Export(context.Background(), "archive\x00ignored")
				return err
			},
		},
		{
			name:      "empty archive path",
			parameter: "archive path",
			call: func() error {
				_, err := runtime.Import(context.Background(), "", "")
				return err
			},
		},
		{
			name:      "NUL archive path",
			parameter: "archive path",
			call: func() error {
				_, err := runtime.Import(context.Background(), "archive.boxlite\x00ignored", "")
				return err
			},
		},
		{
			name:      "NUL import name",
			parameter: "import name",
			call: func() error {
				_, err := runtime.Import(context.Background(), "archive.boxlite", "restored\x00ignored")
				return err
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			if err == nil {
				t.Fatal("expected validation error")
			}
			var boxliteErr *Error
			if !errors.As(err, &boxliteErr) {
				t.Fatalf("expected *Error, got %T: %v", err, err)
			}
			if boxliteErr.Code != ErrInvalidArgument {
				t.Fatalf("error code = %d, want ErrInvalidArgument", boxliteErr.Code)
			}
			if !strings.Contains(err.Error(), tt.parameter) {
				t.Fatalf("error %q does not identify %q", err, tt.parameter)
			}
		})
	}
}

func TestArchiveEmptyNameUsesNull(t *testing.T) {
	cName, freeName := archiveNameCString("")
	defer freeName()
	if cName != nil {
		t.Fatal("empty import name must cross the C boundary as NULL")
	}

	cName, freeName = archiveNameCString("restored")
	defer freeName()
	if cName == nil {
		t.Fatal("non-empty import name unexpectedly mapped to NULL")
	}
	if got := cString(cName); got != "restored" {
		t.Fatalf("converted import name = %q, want %q", got, "restored")
	}
}

func TestArchiveCanceledBeforeSubmission(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	runtime := &Runtime{}
	box := &Box{runtime: runtime}

	if _, err := box.Export(ctx, "archive.boxlite"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Export error = %v, want context.Canceled", err)
	}
	if _, err := runtime.Import(ctx, "archive.boxlite", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("Import error = %v, want context.Canceled", err)
	}
}

func TestArchiveCancellationDuringPreparationPreventsNativeSubmission(t *testing.T) {
	t.Run("Import", func(t *testing.T) {
		started := make(chan struct{})
		releaseNative := make(chan struct{})
		close(releaseNative)
		server := newArchiveImportServer(t, started, releaseNative)
		defer server.Close()

		runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
		if err != nil {
			t.Fatalf("NewRest: %v", err)
		}
		defer runtime.Close()

		archivePath := filepath.Join(t.TempDir(), "input.boxlite")
		if err := os.WriteFile(archivePath, []byte("archive"), 0o600); err != nil {
			t.Fatalf("write archive fixture: %v", err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		resume := make(chan struct{})
		var resumeOnce sync.Once
		t.Cleanup(func() { resumeOnce.Do(func() { close(resume) }) })
		controlled := &cancelBetweenErrChecksContext{
			Context: ctx,
			sampled: make(chan struct{}),
			resume:  resume,
		}
		result := make(chan archiveImportResult, 1)
		go func() {
			box, err := runtime.Import(controlled, archivePath, "")
			result <- archiveImportResult{box: box, err: err}
		}()

		waitForArchiveSignal(t, controlled.sampled, "initial Import context check")
		cancel()
		resumeOnce.Do(func() { close(resume) })

		got := waitForArchiveImport(t, result)
		if got.box != nil {
			defer got.box.Close()
		}
		if !errors.Is(got.err, context.Canceled) {
			t.Fatalf("Import error = %v, want context.Canceled", got.err)
		}
		assertArchiveRequestNotSubmitted(t, started, "Import")
	})

	t.Run("Export", func(t *testing.T) {
		started := make(chan struct{})
		releaseNative := make(chan struct{})
		close(releaseNative)
		server := newArchiveExportServer(t, started, releaseNative)
		defer server.Close()

		runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
		if err != nil {
			t.Fatalf("NewRest: %v", err)
		}
		defer runtime.Close()
		box, err := runtime.Get(context.Background(), "source-box")
		if err != nil {
			t.Fatalf("Get source box: %v", err)
		}
		defer box.Close()
		ctx, cancel := context.WithCancel(context.Background())
		resume := make(chan struct{})
		var resumeOnce sync.Once
		t.Cleanup(func() { resumeOnce.Do(func() { close(resume) }) })
		controlled := &cancelBetweenErrChecksContext{
			Context: ctx,
			sampled: make(chan struct{}),
			resume:  resume,
		}
		result := make(chan archiveExportResult, 1)
		archiveDir := t.TempDir()
		go func() {
			path, err := box.Export(controlled, archiveDir)
			result <- archiveExportResult{path: path, err: err}
		}()

		waitForArchiveSignal(t, controlled.sampled, "initial Export context check")
		cancel()
		resumeOnce.Do(func() { close(resume) })

		got := waitForArchiveExport(t, result)
		if !errors.Is(got.err, context.Canceled) {
			t.Fatalf("Export error = %v, want context.Canceled", got.err)
		}
		assertArchiveRequestNotSubmitted(t, started, "Export")
	})
}

func TestArchiveImportReturnsCancellationAfterSubmission(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once

	server := newArchiveImportServer(t, started, release)
	t.Cleanup(server.Close)

	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Errorf("Close runtime: %v", err)
		}
	})
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
	})

	archivePath := filepath.Join(t.TempDir(), "input.boxlite")
	if err := os.WriteFile(archivePath, []byte("archive"), 0o600); err != nil {
		t.Fatalf("write archive fixture: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan archiveImportResult, 1)
	go func() {
		box, err := runtime.Import(ctx, archivePath, "")
		result <- archiveImportResult{box: box, err: err}
	}()

	waitForArchiveSignal(t, started, "native import submission")
	cancel()

	got := waitForArchiveImport(t, result)
	if got.box != nil {
		_ = got.box.Close()
		t.Fatal("Import returned a box after cancellation")
	}
	if !errors.Is(got.err, context.Canceled) {
		t.Fatalf("Import error = %v, want context.Canceled", got.err)
	}
}

func TestArchiveExportReturnsCancellationAfterSubmission(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once

	server := newArchiveExportServer(t, started, release)
	t.Cleanup(server.Close)

	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Errorf("Close runtime: %v", err)
		}
	})

	box, err := runtime.Get(context.Background(), "source-box")
	if err != nil {
		t.Fatalf("Get source box: %v", err)
	}
	t.Cleanup(func() {
		if err := box.Close(); err != nil {
			t.Errorf("Close box: %v", err)
		}
	})
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
	})

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan archiveExportResult, 1)
	archiveDir := t.TempDir()
	go func() {
		path, err := box.Export(ctx, archiveDir)
		result <- archiveExportResult{path: path, err: err}
	}()

	waitForArchiveSignal(t, started, "native export submission")
	cancel()

	got := waitForArchiveExport(t, result)
	if got.path != "" {
		t.Fatalf("Export path = %q after cancellation, want empty", got.path)
	}
	if !errors.Is(got.err, context.Canceled) {
		t.Fatalf("Export error = %v, want context.Canceled", got.err)
	}
}

func TestArchiveCloseDoesNotWaitForAcceptedImport(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once

	server := newArchiveImportServer(t, started, release)
	t.Cleanup(server.Close)

	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	runtime.ensureDrainRunning()

	closeDone := make(chan struct{})
	closeResult := make(chan error, 1)
	closeStarted := false
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		if !closeStarted {
			_ = runtime.Close()
			return
		}
		select {
		case <-closeDone:
		case <-time.After(5 * time.Second):
			t.Error("Runtime.Close did not finish during cleanup")
		}
	})

	archivePath := filepath.Join(t.TempDir(), "input.boxlite")
	if err := os.WriteFile(archivePath, []byte("archive"), 0o600); err != nil {
		t.Fatalf("write archive fixture: %v", err)
	}

	importResult := make(chan archiveImportResult, 1)
	go func() {
		box, err := runtime.Import(context.Background(), archivePath, "")
		importResult <- archiveImportResult{box: box, err: err}
	}()
	waitForArchiveSignal(t, started, "native import submission")

	closeStarted = true
	go func() {
		closeResult <- runtime.Close()
		close(closeDone)
	}()

	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatalf("Runtime.Close: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Runtime.Close waited for accepted Import")
	}

	imported := waitForArchiveImport(t, importResult)
	if imported.box != nil {
		_ = imported.box.Close()
		t.Fatal("Import returned a box after Runtime.Close")
	}
	if !errors.Is(imported.err, ErrRuntimeClosed) {
		t.Fatalf("Import error = %v, want ErrRuntimeClosed", imported.err)
	}
}

func TestArchiveShutdownDoesNotWaitForAcceptedImport(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once

	server := newArchiveImportServer(t, started, release)
	t.Cleanup(server.Close)

	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Errorf("Close runtime: %v", err)
		}
	})
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
	})

	archivePath := filepath.Join(t.TempDir(), "input.boxlite")
	if err := os.WriteFile(archivePath, []byte("archive"), 0o600); err != nil {
		t.Fatalf("write archive fixture: %v", err)
	}

	importResult := make(chan archiveImportResult, 1)
	go func() {
		box, err := runtime.Import(context.Background(), archivePath, "")
		importResult <- archiveImportResult{box: box, err: err}
	}()
	waitForArchiveSignal(t, started, "native import submission")

	shutdownResult := make(chan error, 1)
	go func() {
		shutdownResult <- runtime.Shutdown(context.Background(), 0)
	}()

	select {
	case err := <-shutdownResult:
		if err != nil {
			t.Fatalf("Runtime.Shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Runtime.Shutdown waited for accepted Import")
	}

	releaseOnce.Do(func() { close(release) })
	imported := waitForArchiveImport(t, importResult)
	if imported.err != nil {
		t.Fatalf("Import after REST Shutdown: %v", imported.err)
	}
	if imported.box == nil {
		t.Fatal("Import after REST Shutdown returned nil box")
	}
	t.Cleanup(func() {
		if err := imported.box.Close(); err != nil {
			t.Errorf("Close imported box: %v", err)
		}
	})

	source, err := runtime.Get(context.Background(), "source-box")
	if err != nil {
		t.Fatalf("Get source box after REST Shutdown: %v", err)
	}
	t.Cleanup(func() {
		if err := source.Close(); err != nil {
			t.Errorf("Close source box: %v", err)
		}
	})
	exportedPath, err := source.Export(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("Export after REST Shutdown: %v", err)
	}
	if _, err := os.Stat(exportedPath); err != nil {
		t.Fatalf("stat archive exported after REST Shutdown: %v", err)
	}
}

func newArchiveImportServer(t *testing.T, started chan<- struct{}, release <-chan struct{}) *httptest.Server {
	t.Helper()
	var startOnce sync.Once
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"capabilities":{"import_enabled":true,"export_enabled":true}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/source-box":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{
				"box_id":"source-box","name":"source-name","status":"stopped",
				"created_at":"2026-08-07T00:00:00Z","updated_at":"2026-08-07T00:00:00Z",
				"pid":null,"image":"source-image","cpus":1,"memory_mib":256
			}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes/import":
			startOnce.Do(func() { close(started) })
			<-release
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{
				"box_id":"imported-box-1","name":null,"status":"stopped",
				"created_at":"2026-08-07T00:00:00Z","updated_at":"2026-08-07T00:00:00Z",
				"pid":null,"image":"archive-image","cpus":1,"memory_mib":256
			}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes/source-box/export":
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = io.WriteString(w, "archive-bytes")
		default:
			http.NotFound(w, r)
		}
	}))
}

func newArchiveExportServer(t *testing.T, started chan<- struct{}, release <-chan struct{}) *httptest.Server {
	t.Helper()
	var startOnce sync.Once

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/source-box":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{
				"box_id":"source-box","name":"source-name","status":"stopped",
				"created_at":"2026-08-07T00:00:00Z","updated_at":"2026-08-07T00:00:00Z",
				"pid":null,"image":"source-image","cpus":1,"memory_mib":256
			}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"capabilities":{"export_enabled":true}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes/source-box/export":
			startOnce.Do(func() { close(started) })
			<-release
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = io.WriteString(w, "archive-bytes")
		default:
			http.NotFound(w, r)
		}
	}))
}

func waitForArchiveSignal(t *testing.T, signal <-chan struct{}, operation string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", operation)
	}
}

func waitForArchiveImport(t *testing.T, result <-chan archiveImportResult) archiveImportResult {
	t.Helper()
	select {
	case got := <-result:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Import result")
		return archiveImportResult{}
	}
}

func waitForArchiveExport(t *testing.T, result <-chan archiveExportResult) archiveExportResult {
	t.Helper()
	select {
	case got := <-result:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Export result")
		return archiveExportResult{}
	}
}

func assertArchiveRequestNotSubmitted(t *testing.T, started <-chan struct{}, operation string) {
	t.Helper()
	select {
	case <-started:
		t.Fatalf("%s submitted native work after its context was canceled", operation)
	default:
	}
}
