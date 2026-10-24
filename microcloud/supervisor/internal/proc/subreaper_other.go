//go:build !linux

package proc

// BecomeSubreaper is a no-op outside Linux: orphans are never re-parented to
// us there, so there is nothing extra to reap. Tests that need orphan
// adoption are Linux-only.
func BecomeSubreaper() error { return nil }
