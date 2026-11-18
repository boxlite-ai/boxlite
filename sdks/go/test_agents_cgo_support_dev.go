//go:build boxlite_dev && boxlite_agent_test

package boxlite

/*
#include "agents_bridge.h"
#include <stdlib.h>
BoxliteErrorCode boxlite_test_agents_new(const char*, CBoxliteRuntime**, struct CAgents**, CBoxliteError*);
bool boxlite_test_agents_wait_pending(CBoxliteRuntime*);
bool boxlite_test_agents_wait_queue(CBoxliteRuntime*, size_t);
void boxlite_test_agents_free_counts(size_t*, size_t*);
*/
import "C"

import (
	"context"
	"runtime"
	"runtime/cgo"
	"unsafe"
)

// Exercise shared call cleanup when C rejects a submission synchronously.
// Public Send validates the mode in Go before reaching this C boundary.
func testAgentNativeRejectedSend(ctx context.Context, agent *Agent) (*agentTurnHandle, error) {
	text := toCString("work")
	defer C.free(unsafe.Pointer(text))
	return agentCall[*agentTurnHandle](ctx, agent.native, func(p *C.struct_CAgent, token C.uintptr_t, err *C.CBoxliteError) C.enum_BoxliteErrorCode {
		opts := C.struct_CAgentSendOptions{mode: 77}
		return C.go_agent_send(p, text, &opts, token, err)
	}, func(h *agentTurnHandle) { h.release() })
}

// A null native argument produces a real C getter error without transferring JSON.
func testAgentNativeRejectedGetter(agent *Agent) (*AgentState, error) {
	return agentGetter(agent.native, func(_ *C.struct_CAgent, json **C.char, err *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_agent_state(nil, json, err)
	}, parseAgentState)
}

// This file is built only by the Go unit target with the C test-support feature.
func newTestAgentNamespace(home string, manualDrain bool) (*Runtime, *Agents, error) {
	cHome := toCString(home)
	defer C.free(unsafe.Pointer(cHome))
	var ptr *C.CBoxliteRuntime
	var agents *C.struct_CAgents
	var cerr C.CBoxliteError
	if C.boxlite_test_agents_new(cHome, &ptr, &agents, &cerr) != C.Ok {
		return nil, nil, freeError(&cerr)
	}
	r := &Runtime{handle: ptr, closing: make(chan struct{})}
	if manualDrain {
		r.drainOnce.Do(func() {})
	}
	h, err := adoptAgentHandle(r, agents, func(p *C.struct_CAgents) { C.boxlite_agents_free(p) })
	if err != nil {
		r.Close()
		return nil, nil, err
	}
	a := &Agents{native: h}
	runtime.AddCleanup(a, func(h *agentNamespace) { h.release() }, h)
	return r, a, nil
}

func testAgentWaitPending(r *Runtime) bool {
	r.agentMu.RLock()
	defer r.agentMu.RUnlock()
	return C.boxlite_test_agents_wait_pending(r.handle) != false
}
func testAgentWaitQueue(r *Runtime, count int) bool {
	r.agentMu.RLock()
	defer r.agentMu.RUnlock()
	return C.boxlite_test_agents_wait_queue(r.handle, C.size_t(count)) != false
}
func testAgentDrain(r *Runtime) int {
	// These tests own the only drainer and call Close after it returns.
	// Dispatch itself takes admission to adopt returned native handles.
	return int(C.boxlite_runtime_drain(r.handle, 0, nil))
}
func testAgentFreeCounts() (int, int) {
	var agents, turns C.size_t
	C.boxlite_test_agents_free_counts(&agents, &turns)
	return int(agents), int(turns)
}

// Expose a real buffered native completion to exercise cancellation after dispatch
// has claimed its cgo token, before the public call consumes the returned handle.
func testAgentSubmitCreate(a *Agents) (<-chan handleResult[*agentSession], cgo.Handle, error) {
	h, err := a.namespace()
	if err != nil {
		return nil, 0, err
	}
	ptr, unlock, err := h.acquire()
	if err != nil {
		return nil, 0, err
	}
	defer unlock()
	op := &agentPending[*agentSession]{owner: h.owner, result: make(chan handleResult[*agentSession], 1)}
	token := registerHandleForDispatch(cgo.NewHandle(op))
	name := toCString("buffered")
	defer C.free(unsafe.Pointer(name))
	var cerr C.CBoxliteError
	if C.go_agent_create(ptr, name, nil, C.uintptr_t(token), &cerr) != C.Ok {
		deleteHandleForDispatch(token)
		return nil, 0, freeError(&cerr)
	}
	return op.result, token, nil
}
