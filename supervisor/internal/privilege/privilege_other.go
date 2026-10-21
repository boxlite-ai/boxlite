//go:build !linux

package privilege

import "errors"

// ErrAlreadyRunning means another root supervisor holds the lock.
var ErrAlreadyRunning = errors.New("another supervisor is already running in this Box")

// Supported is false outside Linux: the supervisor runs as whoever started it.
func Supported() bool { return false }

// Logf is how this package reports progress.
type Logf func(format string, args ...any)

// Result is what Bootstrap hands to main.
type Result struct {
	Config     Config
	UID, GID   int
	SudoLocked bool
}

// IsLauncher is always false outside Linux.
func IsLauncher(string) bool { return false }

// AppIdentity reports no app user outside Linux.
func AppIdentity() (uid, gid int, groups []string, ok bool) {
	return defaultUID, defaultGID, nil, false
}

// Elevate is not available outside Linux.
func Elevate(string) error { return errors.New("privilege split is Linux-only") }

// Bootstrap is not available outside Linux.
func Bootstrap(string, Logf) (*Result, error) {
	return nil, errors.New("privilege split is Linux-only")
}

// Launch is not available outside Linux.
func Launch(Logf) error { return errors.New("privilege split is Linux-only") }
