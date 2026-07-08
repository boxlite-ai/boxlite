//go:build unix

package boxlite

import "syscall"

func closeFd(fd int) error {
	return syscall.Close(fd)
}
