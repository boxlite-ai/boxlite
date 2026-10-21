package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// volume makes a mount dir with one file and a subdirectory, and declares it
// as the only volume for the duration of the test.
func volume(t *testing.T) (g *Server, mount, outside string) {
	t.Helper()
	root := t.TempDir()
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
	prev := declaredMounts
	declaredMounts = func() ([]string, error) { return []string{mount}, nil }
	t.Cleanup(func() { declaredMounts = prev })
	g = New(&fakeOps{}, false)
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

func TestMountsComeFromTheControlPlaneSpec(t *testing.T) {
	calls := 0
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/sv/v1/spec" || r.Header.Get("Authorization") != "Bearer bxt_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"spec": map[string]any{"volumes": []map[string]string{{"name": "uploads", "mount": "/data/uploads"}}}})
	}))
	defer cp.Close()
	t.Setenv("BOXLITE_CP_URL", cp.URL)
	t.Setenv("BOXLITE_BOX_TOKEN", "bxt_test")
	mountsCache.Lock()
	mountsCache.mounts, mountsCache.at = nil, time.Time{}
	mountsCache.Unlock()

	for i := 0; i < 2; i++ {
		mounts, err := mountsFromControlPlane()
		if err != nil || len(mounts) != 1 || mounts[0] != "/data/uploads" {
			t.Fatalf("mounts: %v %v", mounts, err)
		}
	}
	if calls != 1 {
		t.Fatalf("expected one cached call, got %d", calls)
	}

	mountsCache.Lock()
	mountsCache.mounts = nil
	mountsCache.Unlock()
	t.Setenv("BOXLITE_BOX_TOKEN", "wrong")
	if _, err := mountsFromControlPlane(); err == nil {
		t.Fatal("expected an error for a refused spec request")
	}
}

func TestFilesReportUnknownMounts(t *testing.T) {
	prev := declaredMounts
	declaredMounts = func() ([]string, error) { return nil, os.ErrDeadlineExceeded }
	t.Cleanup(func() { declaredMounts = prev })
	g := New(&fakeOps{}, false)
	g.SetSecrets(secret, ctlSecret)
	rec, body := do(t, g, http.MethodGet, filesURL("/data/uploads"), "", ctl())
	if rec.Code != http.StatusServiceUnavailable || body["error"] != "mounts_unknown" {
		t.Fatalf("unknown mounts: %d %s", rec.Code, rec.Body.String())
	}
}

func TestUploadsTakeTheMountOwner(t *testing.T) {
	_, mount, _ := volume(t)
	o := ownerOf(mount)
	if !o.ok || o.uid != os.Getuid() {
		t.Fatalf("owner of %s: %+v", mount, o)
	}
	if ownerOf(filepath.Join(mount, "missing")).ok {
		t.Fatal("a missing path has no owner")
	}
}
