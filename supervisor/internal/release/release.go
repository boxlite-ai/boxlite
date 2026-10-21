// Package release manages the on-box release directories
// (/home/boxlite/app/releases/<N>/): safe extraction of source snapshots and
// pruning of old releases.
package release

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Extract unpacks a tar.gz stream into dir (created if missing). Entries that
// would land outside dir are rejected rather than skipped: a snapshot is a
// single unit, and a partially extracted tree with a hole where the escaping
// entry was would only produce a confusing build failure later.
//
// Rejected: absolute names, any `..` component that escapes dir, symlinks or
// hard links whose target resolves outside dir, and device/fifo entries.
func Extract(r io.Reader, dir string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return err
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return err
	}
	defer root.Close()
	return ExtractIn(r, root, ".", nil)
}

// ExtractIn is Extract into dir relative to root. Every filesystem operation
// goes through root, so nothing can be written outside it even when another
// process swaps a directory for a symlink mid-extraction: the supervisor runs
// as root and the release tree belongs to app code (contracts.md 2.1).
// chown, when set, is called for every entry created (directories included);
// the root supervisor uses it to hand the tree to the app user.
func ExtractIn(r io.Reader, root *os.Root, dir string, chown func(name string) error) error {
	if chown == nil {
		chown = func(string) error { return nil }
	}
	owned := map[string]bool{}
	// mkdirAll creates p and its missing parents below dir, handing each new
	// directory to chown exactly once.
	mkdirAll := func(p string, mode os.FileMode) error {
		if err := root.MkdirAll(p, mode); err != nil {
			return err
		}
		for q := p; ; q = filepath.Dir(q) {
			if owned[q] {
				break
			}
			if err := chown(q); err != nil {
				return err
			}
			owned[q] = true
			if q == dir || q == "." || q == string(filepath.Separator) {
				break
			}
		}
		return nil
	}
	if err := mkdirAll(dir, 0o755); err != nil {
		return err
	}
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("snapshot is not gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read snapshot: %w", err)
		}
		rel, err := safeRel(hdr.Name)
		if err != nil {
			return err
		}
		target := filepath.Join(dir, rel)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := mkdirAll(target, dirMode(hdr.Mode)); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := mkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := root.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return fmt.Errorf("write %s: %w", rel, err)
			}
			if err := f.Close(); err != nil {
				return err
			}
			if err := chown(target); err != nil {
				return err
			}
			if !hdr.ModTime.IsZero() {
				_ = root.Chtimes(target, hdr.ModTime, hdr.ModTime)
			}
		case tar.TypeSymlink:
			if err := checkLink(rel, hdr.Linkname); err != nil {
				return err
			}
			if err := mkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := root.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
			if err := chown(target); err != nil {
				return err
			}
		case tar.TypeLink:
			src, err := safeRel(hdr.Linkname)
			if err != nil {
				return fmt.Errorf("hard link %s: %w", rel, err)
			}
			if err := mkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := root.Link(filepath.Join(dir, src), target); err != nil {
				return err
			}
		case tar.TypeXGlobalHeader:
			// PAX global headers carry no file; archive/tar already applied them.
		default:
			return fmt.Errorf("snapshot entry %q has unsupported type %q", hdr.Name, hdr.Typeflag)
		}
	}
}

// safeRel turns a tar entry name into a relative, cleaned path under the root,
// or returns an error when the name is absolute or escapes upward.
func safeRel(name string) (string, error) {
	if name == "" {
		return ".", nil
	}
	if strings.HasPrefix(name, "/") || filepath.IsAbs(name) {
		return "", fmt.Errorf("snapshot entry %q: absolute paths are not allowed", name)
	}
	rel := filepath.Clean(filepath.FromSlash(name))
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("snapshot entry %q escapes the release directory", name)
	}
	return rel, nil
}

// checkLink verifies that a symlink at rel pointing to linkname stays inside the
// root, judged lexically from the link's own directory.
func checkLink(rel, linkname string) error {
	if linkname == "" {
		return fmt.Errorf("symlink %s: empty target", rel)
	}
	if strings.HasPrefix(linkname, "/") || filepath.IsAbs(linkname) {
		return fmt.Errorf("symlink %s → %s: absolute targets are not allowed", rel, linkname)
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(rel), filepath.FromSlash(linkname)))
	if resolved == ".." || strings.HasPrefix(resolved, ".."+string(filepath.Separator)) {
		return fmt.Errorf("symlink %s → %s escapes the release directory", rel, linkname)
	}
	return nil
}

func fileMode(m int64) os.FileMode {
	mode := os.FileMode(m) & 0o777
	if mode == 0 {
		mode = 0o644
	}
	return mode
}

func dirMode(m int64) os.FileMode {
	mode := os.FileMode(m) & 0o777
	if mode == 0 {
		mode = 0o755
	}
	// The supervisor must always be able to traverse and prune its own releases.
	return mode | 0o700
}

// List returns the deployment numbers of the release directories, ascending.
// Entries that are not plain positive integers are ignored.
func List(releasesDir string) ([]int, error) {
	root, err := os.OpenRoot(releasesDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer root.Close()
	return ListIn(root, ".")
}

// ListIn is List for the directory dir relative to root.
func ListIn(root *os.Root, dir string) ([]int, error) {
	f, err := root.Open(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return nil, err
	}
	var out []int
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		n, err := strconv.Atoi(e.Name())
		if err != nil || n <= 0 || strconv.Itoa(n) != e.Name() {
			continue
		}
		out = append(out, n)
	}
	sort.Ints(out)
	return out, nil
}

// Prune removes release directories beyond the newest keep, never the current
// one. It returns the deployment numbers it removed.
func Prune(releasesDir string, keep, current int) ([]int, error) {
	root, err := os.OpenRoot(releasesDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer root.Close()
	return PruneIn(root, ".", keep, current)
}

// PruneIn is Prune for the directory dir relative to root.
func PruneIn(root *os.Root, dir string, keep, current int) ([]int, error) {
	all, err := ListIn(root, dir)
	if err != nil {
		return nil, err
	}
	if keep < 1 {
		keep = 1
	}
	var removed []int
	// all is ascending; everything before the newest `keep` is a candidate.
	for i := 0; i < len(all)-keep; i++ {
		n := all[i]
		if n == current {
			continue
		}
		if err := root.RemoveAll(filepath.Join(dir, strconv.Itoa(n))); err != nil {
			return removed, err
		}
		removed = append(removed, n)
	}
	return removed, nil
}
