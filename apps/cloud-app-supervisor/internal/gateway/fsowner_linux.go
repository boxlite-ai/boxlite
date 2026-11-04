//go:build linux

package gateway

import (
	"os"
	"runtime"
	"syscall"
)

// asOwner runs fn with the calling thread's filesystem uid and gid set to the
// volume owner's. BoxLite mounts volumes idmapped (virtiofs): the kernel
// refuses to create files there for an id the mapping does not cover, and
// root is not covered, so the root supervisor could read a volume but never
// write to it ("openat …: invalid argument"). With the owner's fsuid the files
// are created as the app would create them; everything else stays root.
//
// fsuid is per thread, so the goroutine is pinned to its thread for fn. If the
// thread cannot be restored to root, it stays locked and is discarded when the
// goroutine ends rather than being reused with the owner's identity.
func asOwner(o fileOwner, fn func() error) error {
	if !o.ok || os.Geteuid() != 0 || o.uid == 0 {
		return fn()
	}
	runtime.LockOSThread()
	syscall.RawSyscall(syscall.SYS_SETFSGID, uintptr(o.gid), 0, 0)
	syscall.RawSyscall(syscall.SYS_SETFSUID, uintptr(o.uid), 0, 0)
	defer func() {
		syscall.RawSyscall(syscall.SYS_SETFSUID, 0, 0, 0)
		syscall.RawSyscall(syscall.SYS_SETFSGID, 0, 0, 0)
		// setfsuid reports the previous id; an id it cannot set (-1) reads it back.
		uid, _, _ := syscall.RawSyscall(syscall.SYS_SETFSUID, ^uintptr(0), 0, 0)
		gid, _, _ := syscall.RawSyscall(syscall.SYS_SETFSGID, ^uintptr(0), 0, 0)
		if uint32(uid) == 0 && uint32(gid) == 0 {
			runtime.UnlockOSThread()
		}
	}()
	return fn()
}
