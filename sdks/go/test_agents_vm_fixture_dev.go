//go:build boxlite_dev && boxlite_agent_vm

package boxlite

/*
#include "agents_bridge.h"
BoxliteErrorCode boxlite_test_agents_install(CBoxHandle*, const char*, const char*, CBoxliteError*);
*/
import "C"
import "runtime"

// Install only prepares a VM test fixture through the existing Rust test API.
// Subsequent visibility, mounting and restart checks use public Go operations.
func installVMTestAgent(box *Box, name, path string) error {
	defer runtime.KeepAlive(box)
	var args agentArguments
	defer args.free()
	n, p := args.string(name, "agent", false), args.string(path, "path", false)
	if args.err != nil {
		return args.err
	}
	handle, unlock, err := box.acquire()
	if err != nil {
		return err
	}
	defer unlock()
	var cerr C.CBoxliteError
	if C.boxlite_test_agents_install(handle, n, p, &cerr) != C.Ok {
		return freeError(&cerr)
	}
	return nil
}
