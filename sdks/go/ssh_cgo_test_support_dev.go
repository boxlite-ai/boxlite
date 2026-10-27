//go:build boxlite_dev

package boxlite

/*
#include "bridge.h"
*/
import "C"

import "unsafe"

// Go does not support importing C from a _test.go file. These helpers stay
// development-only so prebuilt SDK consumers do not compile them.

// countSSHStatusFrees reports each native status release on the returned
// channel until restore runs. Releases still reach the native free.
func countSSHStatusFrees() (freed <-chan struct{}, restore func()) {
	native := freeSSHStatus
	releases := make(chan struct{}, 16)
	freeSSHStatus = func(status *C.CSshStatus) {
		native(status)
		releases <- struct{}{}
	}
	return releases, func() { freeSSHStatus = native }
}

// submitSSHStatus queues a native status read whose callback receives
// userData unchanged, bypassing SSH.Status's own handle registration.
func submitSSHStatus(box *Box, userData unsafe.Pointer) error {
	var cerr C.CBoxliteError
	if code := C.boxlite_box_ssh_status(box.handle, C.cbSSHStatus(), userData, &cerr); code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}
