package gateway

import (
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
)

// serveStatic serves files under dir for a `static` service.
//
//   - Paths are cleaned and any segment starting with "." is refused, so
//     .env, .git/ and friends inside a build output are never served. The one
//     exception is /.well-known/ (RFC 8615: security.txt, assetlinks.json,
//     apple-app-site-association), which exists to be served.
//   - A directory serves its index.html.
//   - A missing path without a file extension falls back to the root
//     index.html so client-side routers work; a missing asset (has an
//     extension) is a plain 404 so a broken bundle reference is visible.
//   - Symlinks are followed only while they stay under dir.
//
// The gateway runs as root and the release tree belongs to app code, which
// may swap a file for a symlink at any moment. Every lookup therefore goes
// through an os.Root, which resolves each path component relative to an open
// directory and refuses to leave it, rather than check-then-open by path.
func (g *Server) serveStatic(w http.ResponseWriter, r *http.Request, dir string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	if hasDotSegment(clean) {
		http.NotFound(w, r)
		return
	}
	root, err := g.static(dir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()

	name := strings.TrimPrefix(clean, "/")
	if name == "" {
		name = "."
	}
	if fi, err := root.Stat(name); err == nil {
		if fi.IsDir() {
			name = path.Join(name, "index.html")
		}
		serveFile(w, r, root, name)
		return
	} else if !errors.Is(err, fs.ErrNotExist) {
		// Escapes (a symlink leading out of dir) and other errors are plain 404s.
		http.NotFound(w, r)
		return
	}
	if path.Ext(clean) == "" {
		serveFile(w, r, root, "index.html")
		return
	}
	http.NotFound(w, r)
}

func hasDotSegment(p string) bool {
	for i, seg := range strings.Split(p, "/") {
		if i == 1 && seg == ".well-known" {
			continue // only as the first segment, and only that name
		}
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

func serveFile(w http.ResponseWriter, r *http.Request, root *os.Root, name string) {
	// O_NONBLOCK: a fifo planted as index.html must not hang the request.
	f, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	ctype := mime.TypeByExtension(filepath.Ext(name))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	// ServeContent handles Range, If-Modified-Since and HEAD; it does not do
	// the index.html redirects that http.ServeFile would.
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}
