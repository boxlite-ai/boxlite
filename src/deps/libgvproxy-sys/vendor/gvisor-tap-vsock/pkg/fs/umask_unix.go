//go:build !windows
// +build !windows

package fs

import "syscall"

func Umask(mask int) int {
	return syscall.Umask(mask)
}
