package state

import (
	"os"
	"path/filepath"
	"testing"
)

// A protocol-1 supervisor kept state.json (with the gateway secret and the
// resolved env) in the app-owned dir. The split store imports it once and
// deletes it there.
func TestSplitImportsAndRemovesLegacyState(t *testing.T) {
	root := t.TempDir()
	stateDir, appDir := filepath.Join(root, "state"), filepath.Join(root, "app")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"current":3,"spec_version":2,"gateway_secret":"old-fwd","releases":[{"deployment":3,"env":{"DATABASE_URL":"postgres://x"}}]}`
	if err := os.WriteFile(filepath.Join(appDir, "state.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenSplit(stateDir, appDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	st := s.Get()
	if st.Current != 3 || st.ForwardSecret != "old-fwd" || st.ControlSecret != "" || st.GatewaySecret != "" || st.Release(3) == nil {
		t.Fatalf("imported state: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(appDir, "state.json")); !os.IsNotExist(err) {
		t.Fatalf("legacy state.json must be gone from the app dir: %v", err)
	}
	if fi, err := os.Stat(filepath.Join(stateDir, "state.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("state.json in the state dir: %v %v", fi, err)
	}
	if fi, _ := os.Stat(stateDir); fi.Mode().Perm() != 0o700 {
		t.Fatalf("state dir mode %v", fi.Mode().Perm())
	}
}

// The gateway serves static files through OpenStatic; a static dir swapped
// for a symlink to the state dir must not open.
func TestOpenStaticStaysInsideTheAppDir(t *testing.T) {
	root := t.TempDir()
	stateDir, appDir := filepath.Join(root, "state"), filepath.Join(root, "app")
	s, err := OpenSplit(stateDir, appDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Update(func(st *State) { st.ControlSecret = "ctl" }); err != nil {
		t.Fatal(err)
	}
	if err := s.ResetRelease(1); err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(s.ReleaseDir(1), "dist")
	if err := os.Symlink(stateDir, dist); err != nil {
		t.Fatal(err)
	}
	if r, err := s.OpenStatic(dist); err == nil {
		r.Close()
		t.Fatal("a static dir symlinked out of the app dir must not open")
	}
	if _, err := s.OpenStatic(stateDir); err == nil {
		t.Fatal("a path outside the app dir must not open")
	}
	if err := os.Remove(dist); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	r, err := s.OpenStatic(dist)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
}
