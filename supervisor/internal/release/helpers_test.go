package release

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Path-based wrappers for the tests; the supervisor itself only ever works
// through an os.Root (state.Store).

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

func openOrNil(dir string) (*os.Root, error) {
	root, err := os.OpenRoot(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return root, err
}

func List(releasesDir string) ([]int, error) {
	root, err := openOrNil(releasesDir)
	if root == nil {
		return nil, err
	}
	defer root.Close()
	return ListIn(root, ".")
}

func Prune(releasesDir string, keep, current int) ([]int, error) {
	root, err := openOrNil(releasesDir)
	if root == nil {
		return nil, err
	}
	defer root.Close()
	return PruneIn(root, ".", keep, current)
}
