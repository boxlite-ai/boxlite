//go:build !linux

package gateway

// asOwner runs fn as is: only Linux has per-thread filesystem ids, and only
// BoxLite's Linux Boxes mount volumes idmapped (fsowner_linux.go).
func asOwner(_ fileOwner, fn func() error) error { return fn() }
