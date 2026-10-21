package gateway

// files serves GET and PUT /.boxlite/sv/files?path=<absolute path> for the
// control plane (contracts.md 4.1 "Volume files"). Only paths under the mount
// point of a volume the environment declares are reachable: the request path
// is cleaned, `..` is refused outright, and every file operation goes through
// an os.Root on the mount, so a symlink inside a volume cannot lead out of it. The gateway secret check in
// ServeHTTP runs before any of this.

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// maxUpload caps one PUT body; the control plane enforces the same limit.
var maxUpload int64 = 50 << 20

// maxEntries caps a directory listing.
const maxEntries = 1000

// declaredMounts returns the mount paths of the environment's volumes. Tests
// replace it; in a Box it asks the control plane for the current spec.
var declaredMounts = mountsFromControlPlane

type fileEntry struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	Mode       string `json:"mode"`
	ModifiedAt string `json:"modified_at"`
}

func fileError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func (g *Server) files(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		g.readFile(w, r)
	case http.MethodPut:
		g.writeFile(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
	}
}

// confine checks raw against the declared mounts and returns the cleaned path
// and the mount it belongs to. The caller still resolves symlinks.
func confine(raw string) (clean, mount string, status int, code, message string) {
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.ContainsRune(raw, 0) {
		return "", "", http.StatusBadRequest, "bad_request", "path must be an absolute path"
	}
	for _, seg := range strings.Split(raw, "/") {
		if seg == ".." {
			return "", "", http.StatusForbidden, "outside_volume", "path must not contain .."
		}
	}
	clean = filepath.Clean(raw)
	mounts, err := declaredMounts()
	if err != nil {
		return "", "", http.StatusServiceUnavailable, "mounts_unknown", err.Error()
	}
	for _, m := range mounts {
		m = filepath.Clean(m)
		if m == "/" || !filepath.IsAbs(m) {
			continue // a volume can never expose the whole filesystem
		}
		if clean == m || strings.HasPrefix(clean, m+"/") {
			return clean, m, 0, "", ""
		}
	}
	return "", "", http.StatusForbidden, "outside_volume", "path is not under a declared volume mount"
}

// openMount opens the volume as an os.Root. Every later operation goes through
// it, so the kernel-level lookup itself refuses `..` and symlinks that leave
// the volume. Checking a path first and then opening it by name would race
// with app code (which can write the volume) swapping in a symlink between the
// two, and the supervisor runs as root.
func openMount(mount string) (*os.Root, error) { return os.OpenRoot(mount) }

// rel turns a cleaned absolute path under mount into the root-relative name.
func rel(clean, mount string) string {
	r := strings.TrimPrefix(strings.TrimPrefix(clean, mount), "/")
	if r == "" {
		return "."
	}
	return r
}

func rootError(w http.ResponseWriter, clean string, err error) {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		fileError(w, http.StatusNotFound, "no_such_file", clean+" does not exist")
	case strings.Contains(err.Error(), "escapes from parent") || strings.Contains(err.Error(), "path escapes"):
		fileError(w, http.StatusForbidden, "outside_volume", "path leads outside the volume")
	default:
		fileError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (g *Server) readFile(w http.ResponseWriter, r *http.Request) {
	clean, mount, status, code, msg := confine(r.URL.Query().Get("path"))
	if status != 0 {
		fileError(w, status, code, msg)
		return
	}
	root, err := openMount(mount)
	if err != nil {
		rootError(w, mount, err)
		return
	}
	defer root.Close()
	name := rel(clean, mount)
	f, err := root.Open(name)
	if err != nil {
		rootError(w, clean, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		rootError(w, clean, err)
		return
	}
	if info.IsDir() {
		listDir(w, clean, f)
		return
	}
	if !info.Mode().IsRegular() {
		fileError(w, http.StatusBadRequest, "bad_request", "not a regular file")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprint(info.Size()))
	w.Header().Set("X-BoxLite-File-Size", fmt.Sprint(info.Size()))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

func listDir(w http.ResponseWriter, dir string, f *os.File) {
	des, err := f.ReadDir(-1)
	if err != nil {
		fileError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	sort.Slice(des, func(i, j int) bool { return des[i].Name() < des[j].Name() })
	entries := make([]fileEntry, 0, min(len(des), maxEntries))
	for _, de := range des[:min(len(des), maxEntries)] {
		info, err := de.Info()
		if err != nil {
			continue // removed while listing
		}
		kind := "other"
		switch {
		case de.Type()&fs.ModeSymlink != 0:
			kind = "symlink"
		case de.IsDir():
			kind = "dir"
		case info.Mode().IsRegular():
			kind = "file"
		}
		entries = append(entries, fileEntry{Name: de.Name(), Type: kind, Size: info.Size(), Mode: info.Mode().Perm().String(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": dir, "type": "dir", "entries": entries, "truncated": len(des) > maxEntries})
}

func (g *Server) writeFile(w http.ResponseWriter, r *http.Request) {
	clean, mount, status, code, msg := confine(r.URL.Query().Get("path"))
	if status != 0 {
		fileError(w, status, code, msg)
		return
	}
	if clean == mount {
		fileError(w, http.StatusBadRequest, "is_directory", "give a file path inside the volume")
		return
	}
	root, err := openMount(mount)
	if err != nil {
		fileError(w, http.StatusNotFound, "no_such_file", "volume "+mount+" is not mounted")
		return
	}
	defer root.Close()
	name := rel(clean, mount)
	replaced := false
	if info, err := root.Lstat(name); err == nil {
		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			fileError(w, http.StatusForbidden, "outside_volume", "refusing to write through a symlink")
			return
		case info.IsDir():
			fileError(w, http.StatusBadRequest, "is_directory", clean+" is a directory")
			return
		case r.URL.Query().Get("overwrite") != "1":
			fileError(w, http.StatusConflict, "exists", clean+" already exists")
			return
		}
		replaced = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		rootError(w, clean, err)
		return
	}
	if r.ContentLength > maxUpload {
		fileError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("file is larger than %d bytes", maxUpload))
		return
	}
	owner := ownerOf(mount)
	dir := filepath.Dir(name)
	if err := mkdirAllOwned(root, dir, owner); err != nil {
		rootError(w, clean, err)
		return
	}
	tmpName := filepath.Join(dir, fmt.Sprintf(".boxlite-upload-%d", time.Now().UnixNano()))
	tmp, err := root.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		rootError(w, clean, err)
		return
	}
	defer func() { _ = root.Remove(tmpName) }() // no-op after the rename
	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, maxUpload))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		fileError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("file is larger than %d bytes", maxUpload))
		return
	}
	if err != nil {
		fileError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	owner.apply(root, tmpName)
	if err := root.Rename(tmpName, name); err != nil {
		rootError(w, clean, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": clean, "bytes": n, "replaced": replaced})
}

// mkdirAllOwned creates dir (relative to root) one segment at a time, giving
// every directory it creates the mount owner.
func mkdirAllOwned(root *os.Root, dir string, owner fileOwner) error {
	if dir == "." || dir == "" {
		return nil
	}
	cur := ""
	for _, seg := range strings.Split(dir, "/") {
		cur = filepath.Join(cur, seg)
		err := root.Mkdir(cur, 0o755)
		switch {
		case err == nil:
			owner.apply(root, cur)
		case errors.Is(err, fs.ErrExist):
			if info, serr := root.Lstat(cur); serr != nil || !info.IsDir() {
				return fmt.Errorf("%s is not a directory: path escapes from parent", cur)
			}
		default:
			return err
		}
	}
	return nil
}

// fileOwner is the uid/gid new files get: the mount's own owner, because the
// supervisor runs as root while app services run as an unprivileged user that
// must be able to change what an agent uploaded.
type fileOwner struct {
	uid, gid int
	ok       bool
}

func ownerOf(p string) fileOwner {
	info, err := os.Stat(p)
	if err != nil {
		return fileOwner{}
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileOwner{}
	}
	return fileOwner{uid: int(st.Uid), gid: int(st.Gid), ok: true}
}

// apply is best effort: without root (tests, local runs) the file simply keeps
// the supervisor's own uid, which is then the mount owner anyway.
func (o fileOwner) apply(root *os.Root, name string) {
	if o.ok && os.Geteuid() == 0 {
		_ = root.Lchown(name, o.uid, o.gid)
	}
}

// ---- declared mounts from the control plane --------------------------------

const mountsTTL = 15 * time.Second

var mountsCache struct {
	sync.Mutex
	at     time.Time
	mounts []string
}

// mountsFromControlPlane reads `spec.volumes[].mount` from GET /sv/v1/spec,
// the same document the deploy manager acts on, using the Box's own
// credentials. Cached briefly: a volume change replaces the Box anyway.
func mountsFromControlPlane() ([]string, error) {
	mountsCache.Lock()
	defer mountsCache.Unlock()
	if mountsCache.mounts != nil && time.Since(mountsCache.at) < mountsTTL {
		return mountsCache.mounts, nil
	}
	base, token := strings.TrimRight(os.Getenv("BOXLITE_CP_URL"), "/"), os.Getenv("BOXLITE_BOX_TOKEN")
	if base == "" || token == "" {
		return nil, errors.New("BOXLITE_CP_URL / BOXLITE_BOX_TOKEN not set")
	}
	client := &http.Client{Timeout: 10 * time.Second}
	if isOn(os.Getenv("SV_CP_INSECURE")) {
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} //nolint:gosec // local tests only, as for the cp client
	}
	req, err := http.NewRequest(http.MethodGet, base+"/sv/v1/spec", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("control plane: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("control plane: GET /sv/v1/spec → %d", res.StatusCode)
	}
	var body struct {
		Spec *struct {
			Volumes []struct {
				Mount string `json:"mount"`
			} `json:"volumes"`
		} `json:"spec"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("control plane spec: %w", err)
	}
	mounts := []string{}
	if body.Spec != nil {
		for _, v := range body.Spec.Volumes {
			if v.Mount != "" {
				mounts = append(mounts, v.Mount)
			}
		}
	}
	mountsCache.at, mountsCache.mounts = time.Now(), mounts
	return mounts, nil
}

func isOn(v string) bool {
	switch v {
	case "1", "true", "TRUE", "yes", "on":
		return true
	}
	return false
}
