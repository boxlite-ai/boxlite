//go:build linux

package proc

import "syscall"

const prSetChildSubreaper = 36 // PR_SET_CHILD_SUBREAPER, linux/prctl.h

// BecomeSubreaper asks the kernel to re-parent orphaned descendants to this
// process instead of PID 1. As PID 1 the supervisor already receives them, so
// this only matters when it runs elsewhere (tests, a developer's shell); it
// keeps the reaper's behaviour identical in both places.
func BecomeSubreaper() error {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		return errno
	}
	return nil
}
