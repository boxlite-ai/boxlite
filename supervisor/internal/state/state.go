// Package state persists what the supervisor must remember across Box
// stop/start cycles: the current deployment, the spec version, the forward and
// control secrets, and every known release together with the spec and
// environment it was built with.
//
// Two directories (contracts.md 2.1):
//
//   - the state dir holds state.json. In a Box it is root-only (0700 root,
//     /home/boxlite/.microcloud-root): it carries both secrets and the resolved
//     env (DATABASE_URL, secrets), which app code must never read.
//   - the app dir holds releases/<N>/ and the `current` symlink. It belongs to
//     the app user, because builds write into their release dir.
//
// Locally and in tests both are the same directory (Open). Every operation in
// the app dir goes through an os.Root, so a root supervisor never follows a
// symlink that app code planted out of it.
//
// The environment is stored on purpose: on wake the control plane may be
// unreachable, and the current release has to come back with the exact
// variables it was last started with.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/nofollow"
	"github.com/boxlite-ai/microcloud/supervisor/internal/release"
)

// Release is one extracted and built release directory.
type Release struct {
	Deployment  int               `json:"deployment"`
	SpecVersion int               `json:"spec_version"`
	Spec        api.Spec          `json:"spec"`
	Env         map[string]string `json:"env"`
	BuiltAt     time.Time         `json:"built_at"`
	ActivatedAt *time.Time        `json:"activated_at,omitempty"`
}

// State is the on-disk document.
type State struct {
	Current       int    `json:"current"` // deployment number; 0 = nothing live yet
	SpecVersion   int    `json:"spec_version"`
	ForwardSecret string `json:"forward_secret,omitempty"`
	ControlSecret string `json:"control_secret,omitempty"`
	// GatewaySecret is the protocol-1 name of the forward secret, read from
	// state files written before the split and never written again.
	GatewaySecret string    `json:"gateway_secret,omitempty"`
	Releases      []Release `json:"releases"`
}

// Release returns the record for deployment n, or nil.
func (s *State) Release(n int) *Release {
	for i := range s.Releases {
		if s.Releases[i].Deployment == n {
			return &s.Releases[i]
		}
	}
	return nil
}

// CurrentRelease returns the record of the live deployment, or nil.
func (s *State) CurrentRelease() *Release {
	if s.Current == 0 {
		return nil
	}
	return s.Release(s.Current)
}

// Upsert replaces or appends a release record, keeping the list ordered.
func (s *State) Upsert(r Release) {
	if cur := s.Release(r.Deployment); cur != nil {
		*cur = r
		return
	}
	s.Releases = append(s.Releases, r)
	sort.Slice(s.Releases, func(i, j int) bool { return s.Releases[i].Deployment < s.Releases[j].Deployment })
}

// Forget drops release records whose directories were pruned.
func (s *State) Forget(numbers []int) {
	gone := map[int]bool{}
	for _, n := range numbers {
		gone[n] = true
	}
	kept := s.Releases[:0]
	for _, r := range s.Releases {
		if !gone[r.Deployment] {
			kept = append(kept, r)
		}
	}
	s.Releases = kept
}

// Owner is who the app dir's entries belong to when the supervisor is root.
type Owner struct{ UID, GID int }

// Store is the two directories plus a cached copy of state.json.
type Store struct {
	dir    string   // state.json
	appDir string   // releases/, current
	root   *os.Root // dir
	app    *os.Root // appDir
	owner  *Owner

	mu sync.Mutex
	st State
}

// Open uses one directory for state and releases (local runs, tests).
func Open(dir string) (*Store, error) { return OpenSplit(dir, dir, nil) }

// OpenSplit prepares the layout and loads state.json. The caller has already
// made stateDir safe (root-owned 0700 in a Box). With owner set, the app dir
// and everything created in it is handed to that uid/gid.
//
// A state.json left in the app dir by a protocol-1 supervisor (which ran as
// the app user) is imported once and deleted, so the secrets it held do not
// stay readable by app code.
func OpenSplit(stateDir, appDir string, owner *Owner) (*Store, error) {
	absState, err := filepath.Abs(stateDir)
	if err != nil {
		return nil, err
	}
	absApp, err := filepath.Abs(appDir)
	if err != nil {
		return nil, err
	}
	stateMode := os.FileMode(0o755)
	if absState != absApp {
		stateMode = 0o700
	}
	if err := os.MkdirAll(absState, stateMode); err != nil {
		return nil, fmt.Errorf("state dir: %w", err)
	}
	if err := os.MkdirAll(absApp, 0o755); err != nil {
		return nil, fmt.Errorf("app dir: %w", err)
	}
	s := &Store{dir: absState, appDir: absApp, owner: owner}
	if s.root, err = os.OpenRoot(absState); err != nil {
		return nil, fmt.Errorf("state dir: %w", err)
	}
	if owner != nil {
		// Root mode: the opened state dir itself (not the path) must be ours
		// and closed.
		fi, err := s.root.Stat(".")
		if err != nil || fi.Mode().Perm() != 0o700 || !ownedBy(fi, os.Geteuid()) {
			return nil, fmt.Errorf("state dir %s must be a 0700 directory owned by uid %d", absState, os.Geteuid())
		}
		// The app dir and its parent belong to the app user, who could swap
		// either for a symlink between a check and an open. Opening it
		// without following any link, and then working only through that
		// handle, leaves no such window: everything below (chown included)
		// acts on the directory that was checked.
		if s.app, err = nofollow.OpenRoot(absApp); err != nil {
			return nil, fmt.Errorf("app dir %s: %w", absApp, err)
		}
	} else if s.app, err = os.OpenRoot(absApp); err != nil {
		return nil, fmt.Errorf("app dir: %w", err)
	}
	if err := s.chown("."); err != nil {
		return nil, fmt.Errorf("app dir: %w", err)
	}
	// releases/ is app-owned: anything but a real directory there (a symlink
	// out of the app dir would make every later operation fail) is moved aside.
	if fi, err := s.app.Lstat("releases"); err == nil && (!fi.IsDir() || fi.Mode()&os.ModeSymlink != 0) {
		if err := s.app.Rename("releases", fmt.Sprintf("releases.moved-%d", time.Now().UnixNano())); err != nil {
			return nil, fmt.Errorf("app dir: %w", err)
		}
	}
	if err := s.app.MkdirAll("releases", 0o755); err != nil {
		return nil, fmt.Errorf("app dir: %w", err)
	}
	if err := s.chown("releases"); err != nil {
		return nil, fmt.Errorf("app dir: %w", err)
	}

	data, err := s.root.ReadFile("state.json")
	if errors.Is(err, os.ErrNotExist) && absState != absApp {
		if legacy, lerr := s.app.ReadFile("state.json"); lerr == nil {
			data, err = legacy, nil
			defer func() {
				for _, f := range []string{"state.json", "state.json.tmp", "state.json.corrupt"} {
					_ = s.app.Remove(f)
				}
			}()
		}
	}
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(data, &s.st); err != nil {
		// A corrupt file must not brick the box: start empty and let the control
		// plane re-drive a deploy. The broken file is kept for inspection.
		_ = s.root.Rename("state.json", "state.json.corrupt")
		s.st = State{}
		return s, nil
	}
	if s.st.ForwardSecret == "" {
		s.st.ForwardSecret = s.st.GatewaySecret
	}
	s.st.GatewaySecret = ""
	if absState != absApp {
		// Persist the import (and the dropped legacy field) before the legacy
		// copy is deleted.
		if err := s.write(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Close releases the directory handles.
func (s *Store) Close() {
	s.root.Close()
	s.app.Close()
}

func ownedBy(fi os.FileInfo, uid int) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == uid
}

func (s *Store) chown(name string) error {
	if s.owner == nil {
		return nil
	}
	return s.app.Lchown(name, s.owner.UID, s.owner.GID)
}

// Dir is the state directory.
func (s *Store) Dir() string { return s.dir }

// ReleasesDir is <app dir>/releases.
func (s *Store) ReleasesDir() string { return filepath.Join(s.appDir, "releases") }

// ReleaseDir is <app dir>/releases/<n>.
func (s *Store) ReleaseDir(n int) string { return filepath.Join(s.ReleasesDir(), strconv.Itoa(n)) }

func releaseRel(n int) string { return filepath.Join("releases", strconv.Itoa(n)) }

// CurrentLink is the <app dir>/current symlink path.
func (s *Store) CurrentLink() string { return filepath.Join(s.appDir, "current") }

// ReleaseExists reports whether releases/<n> is a directory.
func (s *Store) ReleaseExists(n int) bool {
	fi, err := s.app.Stat(releaseRel(n))
	return err == nil && fi.IsDir()
}

// ListReleases returns the release numbers on disk, ascending.
func (s *Store) ListReleases() ([]int, error) { return release.ListIn(s.app, "releases") }

// ResetRelease empties releases/<n>, leaving a fresh directory owned by the app user.
func (s *Store) ResetRelease(n int) error {
	if err := s.app.RemoveAll(releaseRel(n)); err != nil {
		return err
	}
	if err := s.app.Mkdir(releaseRel(n), 0o755); err != nil {
		return err
	}
	return s.chown(releaseRel(n))
}

// RemoveRelease deletes releases/<n>.
func (s *Store) RemoveRelease(n int) error { return s.app.RemoveAll(releaseRel(n)) }

// ExtractRelease unpacks a snapshot into releases/<n>.
func (s *Store) ExtractRelease(n int, r io.Reader) error {
	return release.ExtractIn(r, s.app, releaseRel(n), s.chown)
}

// Prune removes releases beyond the newest keep, never current.
func (s *Store) Prune(keep, current int) ([]int, error) {
	return release.PruneIn(s.app, "releases", keep, current)
}

// OpenStatic opens dir, which must lie inside the app dir, as an os.Root that
// is itself confined to the app dir: a static directory swapped for a symlink
// (to the state dir, say) fails to open instead of being served.
func (s *Store) OpenStatic(dir string) (*os.Root, error) {
	rel, err := filepath.Rel(s.appDir, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil, fmt.Errorf("static dir %s is outside %s", dir, s.appDir)
	}
	return s.app.OpenRoot(rel)
}

// Get returns a copy of the state.
func (s *Store) Get() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := s.st
	cp.Releases = append([]Release(nil), s.st.Releases...)
	return cp
}

// Update mutates the state under lock and writes it atomically.
func (s *Store) Update(fn func(*State)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.st)
	return s.write()
}

// SetCurrent points the `current` symlink at releases/<n> and records it.
func (s *Store) SetCurrent(n, specVersion int) error {
	// A temporary link renamed over the old one keeps `current` valid at every
	// instant for anyone (a shell, a future tool) that resolves it.
	const tmp = "current.tmp"
	_ = s.app.Remove(tmp)
	if err := s.app.Symlink(releaseRel(n), tmp); err != nil {
		return err
	}
	_ = s.chown(tmp)
	if err := s.app.Rename(tmp, "current"); err != nil {
		_ = s.app.Remove(tmp)
		return err
	}
	now := time.Now().UTC()
	return s.Update(func(st *State) {
		st.Current = n
		st.SpecVersion = specVersion
		if r := st.Release(n); r != nil {
			r.ActivatedAt = &now
		}
	})
}

func (s *Store) write() error {
	data, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	if err := s.root.WriteFile("state.json.tmp", data, 0o600); err != nil {
		return err
	}
	return s.root.Rename("state.json.tmp", "state.json")
}
