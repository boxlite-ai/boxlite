// Package nofollow opens a directory by absolute path without following a
// symbolic link in any component of the path.
//
// The supervisor runs as root and opens directories whose path (or a parent
// of it) app code may be able to change: a volume's mount point, the app
// dir. os.OpenRoot(path) resolves symlinks in path itself, so a planted link
// would hand the supervisor a directory elsewhere, and checking the path first
// (Lstat) and opening it afterwards races with the swap. OpenRoot here walks
// the path one component at a time through os.Root handles and checks that
// each directory it opened is the very one it inspected.
package nofollow

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// ErrSymlink means a component of the path is a symbolic link, or was
// swapped for something else while the path was being opened.
var ErrSymlink = errors.New("path contains a symbolic link")

// OpenRoot opens the absolute directory path as an os.Root. It fails with
// ErrSymlink (wrapped in an *fs.PathError) when any component is a symlink.
func OpenRoot(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) {
		return nil, &fs.PathError{Op: "open", Path: path, Err: errors.New("not an absolute path")}
	}
	cur, err := os.OpenRoot("/")
	if err != nil {
		return nil, err
	}
	walked := "/"
	for _, comp := range strings.Split(filepath.Clean(path), string(filepath.Separator)) {
		if comp == "" {
			continue
		}
		walked = filepath.Join(walked, comp)
		next, err := step(cur, comp, walked)
		cur.Close()
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

// step opens the directory comp inside cur, refusing symlinks. Root.OpenRoot
// would follow a link that stays inside cur, so the directory actually opened
// is compared with what Lstat saw: if the entry was swapped in between, they
// differ and the open is refused.
func step(cur *os.Root, comp, walked string) (*os.Root, error) {
	fi, err := cur.Lstat(comp)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: walked, Err: unwrapPathError(err)}
	}
	switch {
	case fi.Mode()&fs.ModeSymlink != 0:
		return nil, &fs.PathError{Op: "open", Path: walked, Err: ErrSymlink}
	case !fi.IsDir():
		return nil, &fs.PathError{Op: "open", Path: walked, Err: syscall.ENOTDIR}
	}
	next, err := cur.OpenRoot(comp)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: walked, Err: unwrapPathError(err)}
	}
	got, err := next.Stat(".")
	if err != nil || !os.SameFile(fi, got) {
		next.Close()
		return nil, &fs.PathError{Op: "open", Path: walked, Err: fmt.Errorf("%w (changed while being opened)", ErrSymlink)}
	}
	return next, nil
}

func unwrapPathError(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
