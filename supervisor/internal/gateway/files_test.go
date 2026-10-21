package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/cp"
)

func staticMounts(mounts ...string) MountSource {
	return func(context.Context) ([]string, error) { return mounts, nil }
}

// realTemp is t.TempDir with its own symlinks resolved: mounts are opened
// without following any link, and macOS keeps temp dirs under /var, itself a
// link to /private/var.
func realTemp(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// volume makes a mount dir with one file and a subdirectory, and declares it
// as the only volume.
func volume(t *testing.T) (g *Server, mount, outside string) {
	t.Helper()
	root := realTemp(t)
	mount = filepath.Join(root, "data", "uploads")
	outside = filepath.Join(root, "secret")
	for _, d := range []string{filepath.Join(mount, "avatars"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(mount, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "state.json"), []byte(`{"gateway_secret":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	g = New(&fakeOps{}, false, WithMounts(staticMounts(mount)))
	g.SetSecrets(secret, ctlSecret)
	return g, mount, outside
}

func filesURL(p string, extra ...string) string {
	q := url.Values{"path": {p}}
	for i := 0; i+1 < len(extra); i += 2 {
		q.Set(extra[i], extra[i+1])
	}
	return "/.boxlite/sv/files?" + q.Encode()
}

func TestFilesNeedTheGatewaySecret(t *testing.T) {
	g, mount, _ := volume(t)
	rec, body := do(t, g, http.MethodGet, filesURL(mount), "", nil)
	if rec.Code != http.StatusForbidden || body["error"] != "gateway" {
		t.Fatalf("without secret: %d %s", rec.Code, rec.Body.String())
	}
}

func TestFilesListAndRead(t *testing.T) {
	g, mount, _ := volume(t)
	rec, body := do(t, g, http.MethodGet, filesURL(mount), "", ctl())
	if rec.Code != http.StatusOK || body["type"] != "dir" {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	entries := body["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("entries: %v", entries)
	}
	first := entries[0].(map[string]any)
	if first["name"] != "a.txt" || first["type"] != "file" || first["size"] != float64(5) {
		t.Fatalf("first entry: %v", first)
	}
	if second := entries[1].(map[string]any); second["name"] != "avatars" || second["type"] != "dir" {
		t.Fatalf("second entry: %v", second)
	}

	rec, _ = do(t, g, http.MethodGet, filesURL(mount+"/a.txt"), "", ctl())
	if rec.Code != http.StatusOK || rec.Body.String() != "hello" || rec.Header().Get("Content-Type") != "application/octet-stream" || rec.Header().Get("X-BoxLite-File-Size") != "5" {
		t.Fatalf("read: %d %q %v", rec.Code, rec.Body.String(), rec.Header())
	}

	rec, body = do(t, g, http.MethodGet, filesURL(mount+"/nope.txt"), "", ctl())
	if rec.Code != http.StatusNotFound || body["error"] != "no_such_file" {
		t.Fatalf("missing: %d %s", rec.Code, rec.Body.String())
	}
}

func TestFilesStayInsideDeclaredMounts(t *testing.T) {
	g, mount, outside := volume(t)
	cases := map[string]string{
		"traversal":       mount + "/../../secret/state.json",
		"dotdot back in":  mount + "/avatars/../../uploads/a.txt",
		"sibling prefix":  mount + "-other/x",
		"not a mount":     outside + "/state.json",
		"filesystem root": "/etc/passwd",
	}
	for name, p := range cases {
		rec, body := do(t, g, http.MethodGet, filesURL(p), "", ctl())
		if rec.Code != http.StatusForbidden || body["error"] != "outside_volume" {
			t.Errorf("%s (%s): %d %s", name, p, rec.Code, rec.Body.String())
		}
	}
	rec, body := do(t, g, http.MethodGet, filesURL("relative/path"), "", ctl())
	if rec.Code != http.StatusBadRequest || body["error"] != "bad_request" {
		t.Errorf("relative: %d %s", rec.Code, rec.Body.String())
	}

	// A symlink inside the volume must not lead out of it, for reads or writes.
	if err := os.Symlink(outside, filepath.Join(mount, "escape")); err != nil {
		t.Fatal(err)
	}
	rec, body = do(t, g, http.MethodGet, filesURL(mount+"/escape/state.json"), "", ctl())
	if rec.Code != http.StatusForbidden || body["error"] != "outside_volume" {
		t.Errorf("symlink read: %d %s", rec.Code, rec.Body.String())
	}
	rec, body = do(t, g, http.MethodPut, filesURL(mount+"/escape/new.txt"), "x", ctl())
	if rec.Code != http.StatusForbidden || body["error"] != "outside_volume" {
		t.Errorf("symlink dir write: %d %s", rec.Code, rec.Body.String())
	}
	if err := os.Symlink(filepath.Join(outside, "state.json"), filepath.Join(mount, "link.json")); err != nil {
		t.Fatal(err)
	}
	rec, body = do(t, g, http.MethodPut, filesURL(mount+"/link.json", "overwrite", "1"), "x", ctl())
	if rec.Code != http.StatusForbidden || body["error"] != "outside_volume" {
		t.Errorf("symlink file write: %d %s", rec.Code, rec.Body.String())
	}
	if data, _ := os.ReadFile(filepath.Join(outside, "state.json")); string(data) != `{"gateway_secret":"x"}` {
		t.Fatalf("outside file changed: %s", data)
	}
}

func TestFilesWrite(t *testing.T) {
	g, mount, _ := volume(t)
	target := mount + "/avatars/2026/me.png"
	rec, body := do(t, g, http.MethodPut, filesURL(target), "PNG", ctl())
	if rec.Code != http.StatusOK || body["bytes"] != float64(3) || body["replaced"] != false {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	if data, _ := os.ReadFile(target); string(data) != "PNG" {
		t.Fatalf("content: %q", data)
	}
	rec, body = do(t, g, http.MethodPut, filesURL(target), "PNG2", ctl())
	if rec.Code != http.StatusConflict || body["error"] != "exists" {
		t.Fatalf("no overwrite: %d %s", rec.Code, rec.Body.String())
	}
	rec, body = do(t, g, http.MethodPut, filesURL(target, "overwrite", "1"), "PNG2", ctl())
	if rec.Code != http.StatusOK || body["replaced"] != true {
		t.Fatalf("overwrite: %d %s", rec.Code, rec.Body.String())
	}
	rec, body = do(t, g, http.MethodPut, filesURL(mount+"/avatars"), "x", ctl())
	if rec.Code != http.StatusBadRequest || body["error"] != "is_directory" {
		t.Fatalf("dir: %d %s", rec.Code, rec.Body.String())
	}
	rec, _ = do(t, g, http.MethodDelete, filesURL(target), "", ctl())
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("delete: %d", rec.Code)
	}
	leftovers, _ := filepath.Glob(filepath.Join(mount, "avatars", "2026", ".boxlite-upload-*"))
	if len(leftovers) != 0 {
		t.Fatalf("temp files left: %v", leftovers)
	}
}

func TestFilesRejectOversizedUploads(t *testing.T) {
	g, mount, _ := volume(t)
	prev := maxUpload
	maxUpload = 4
	t.Cleanup(func() { maxUpload = prev })
	rec, body := do(t, g, http.MethodPut, filesURL(mount+"/big.bin"), strings.Repeat("x", 10), ctl())
	if rec.Code != http.StatusRequestEntityTooLarge || body["error"] != "too_large" {
		t.Fatalf("too large: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(mount + "/big.bin"); !os.IsNotExist(err) {
		t.Fatalf("partial file written: %v", err)
	}
}

// TestFilesUseTheControlPlaneSpecForMounts wires the gateway exactly as
// main does, to the control-plane client's VolumeMounts, so the confinement
// that runs in a Box is the one under test.
func TestFilesUseTheControlPlaneSpecForMounts(t *testing.T) {
	base := realTemp(t)
	mount := filepath.Join(base, "data", "uploads")
	if err := os.MkdirAll(mount, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mount, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "secret.txt"), []byte("no"), 0o600); err != nil {
		t.Fatal(err)
	}
	refuse := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if refuse || r.URL.Path != "/sv/v1/spec" || r.Header.Get("Authorization") != "Bearer bxt_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"spec": map[string]any{"volumes": []map[string]string{{"name": "uploads", "mount": mount}}}, "deployment": 1})
	}))
	defer srv.Close()
	client, err := cp.New(srv.URL, "bxt_test", false)
	if err != nil {
		t.Fatal(err)
	}
	g := New(&fakeOps{}, false, WithMounts(client.VolumeMounts))
	g.SetSecrets(secret, ctlSecret)

	if rec, _ := do(t, g, http.MethodGet, filesURL(mount+"/a.txt"), "", ctl()); rec.Code != http.StatusOK || rec.Body.String() != "hello" {
		t.Fatalf("inside the declared mount: %d %s", rec.Code, rec.Body.String())
	}
	if rec, body := do(t, g, http.MethodGet, filesURL(filepath.Join(base, "secret.txt")), "", ctl()); rec.Code != http.StatusForbidden || body["error"] != "outside_volume" {
		t.Fatalf("outside the declared mount: %d %s", rec.Code, rec.Body.String())
	}

	// A control plane that refuses the spec leaves the mounts unknown: refuse.
	refuse = true
	fresh, _ := cp.New(srv.URL, "bxt_test", false)
	g = New(&fakeOps{}, false, WithMounts(fresh.VolumeMounts))
	g.SetSecrets(secret, ctlSecret)
	if rec, body := do(t, g, http.MethodGet, filesURL(mount+"/a.txt"), "", ctl()); rec.Code != http.StatusServiceUnavailable || body["error"] != "mounts_unknown" {
		t.Fatalf("refused spec: %d %s", rec.Code, rec.Body.String())
	}
}

func TestFilesReportUnknownMounts(t *testing.T) {
	failing := func(context.Context) ([]string, error) { return nil, os.ErrDeadlineExceeded }
	for name, g := range map[string]*Server{
		"lookup fails":    New(&fakeOps{}, false, WithMounts(failing)),
		"no mount source": New(&fakeOps{}, false),
	} {
		g.SetSecrets(secret, ctlSecret)
		rec, body := do(t, g, http.MethodGet, filesURL("/data/uploads"), "", ctl())
		if rec.Code != http.StatusServiceUnavailable || body["error"] != "mounts_unknown" {
			t.Fatalf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
}

// TestFilesRefuseASymlinkedMount: if the mount point or one of its parents
// is a symlink, the root gateway must not follow it, for reads or writes.
func TestFilesRefuseASymlinkedMount(t *testing.T) {
	base := realTemp(t)
	outside := filepath.Join(base, "secret")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "state.json"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(base, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Join(base, "data", "uploads")
	if err := os.Symlink(outside, leaf); err != nil {
		t.Fatal(err)
	}
	// A real directory named like a mount, reached through a symlinked parent.
	if err := os.MkdirAll(filepath.Join(outside, "uploads"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "uploads", "state.json"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(base, "linkparent")); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(base, "linkparent", "uploads")
	for name, mount := range map[string]string{"symlinked mount point": leaf, "symlinked parent": parent} {
		g := New(&fakeOps{}, false, WithMounts(staticMounts(mount)))
		g.SetSecrets(secret, ctlSecret)
		rec, body := do(t, g, http.MethodGet, filesURL(mount+"/state.json"), "", ctl())
		if rec.Code != http.StatusForbidden || body["error"] != "outside_volume" {
			t.Errorf("%s read: %d %s", name, rec.Code, rec.Body.String())
		}
		rec, body = do(t, g, http.MethodPut, filesURL(mount+"/new.txt"), "x", ctl())
		if rec.Code != http.StatusForbidden || body["error"] != "outside_volume" {
			t.Errorf("%s write: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	for _, p := range []string{filepath.Join(outside, "new.txt"), filepath.Join(outside, "uploads", "new.txt")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("a write went through a symlinked mount: %s", p)
		}
	}
}

// TestFilesDoNotHangOnAFifo: a fifo app code planted in a volume must be
// refused, not block the request waiting for a writer.
func TestFilesDoNotHangOnAFifo(t *testing.T) {
	g, mount, _ := volume(t)
	if err := syscall.Mkfifo(filepath.Join(mount, "pipe"), 0o644); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	done := make(chan struct{})
	var code int
	go func() {
		defer close(done)
		rec, _ := do(t, g, http.MethodGet, filesURL(mount+"/pipe"), "", ctl())
		code = rec.Code
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("GET of a fifo hung")
	}
	if code != http.StatusBadRequest {
		t.Fatalf("fifo: %d", code)
	}
}

func TestUploadsTakeTheMountOwner(t *testing.T) {
	_, mount, _ := volume(t)
	root, err := openMount(mount)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if o := ownerOf(root); !o.ok || o.uid != os.Getuid() {
		t.Fatalf("owner of %s: %+v", mount, o)
	}
}
