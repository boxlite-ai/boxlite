package boxlite

/*
#include "agents_bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"runtime"
	"runtime/cgo"
	"strings"
	"sync"
	"unicode/utf8"
	"unsafe"
)

type agentResource interface{ release() }
type agentNamespace = agentHandle[*C.struct_CAgents]
type agentSession = agentHandle[*C.struct_CAgent]
type agentTurnHandle = agentHandle[*C.struct_CAgentTurn]

// Lock order is runtime admission, then handle. Both protect only the
// synchronous C submission, never the wait for its completion callback.
type agentHandle[P comparable] struct {
	owner *Runtime
	mu    sync.RWMutex
	ptr   P
	free  func(P)
}

func (h *agentHandle[P]) acquire() (P, func(), error) {
	var zero P
	if h == nil || h.owner == nil {
		return zero, nil, agentJSONError(ErrInvalidState, "agent handle is not initialized")
	}
	r := h.owner
	r.agentMu.RLock()
	if r.agentClosed || r.handle == nil {
		r.agentMu.RUnlock()
		return zero, nil, ErrRuntimeClosed
	}
	h.mu.RLock()
	if h.ptr == zero {
		h.mu.RUnlock()
		r.agentMu.RUnlock()
		return zero, nil, agentJSONError(ErrInvalidState, "agent handle is released")
	}
	return h.ptr, func() { h.mu.RUnlock(); r.agentMu.RUnlock() }, nil
}

func (h *agentHandle[P]) release() {
	if h == nil {
		return
	}
	r := h.owner
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	h.mu.Lock()
	defer h.mu.Unlock()
	var zero P
	if h.ptr != zero {
		h.free(h.ptr)
		h.ptr = zero
		delete(r.agentHandles, h)
	}
}

func adoptAgentHandle[P comparable](r *Runtime, ptr P, free func(P)) (*agentHandle[P], error) {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	if r.agentClosed {
		free(ptr)
		return nil, ErrRuntimeClosed
	}
	return registerAgentHandle(r, ptr, free), nil
}

// The caller holds runtime admission exclusively.
func registerAgentHandle[P comparable](r *Runtime, ptr P, free func(P)) *agentHandle[P] {
	h := &agentHandle[P]{owner: r, ptr: ptr, free: free}
	if r.agentHandles == nil {
		r.agentHandles = make(map[agentResource]struct{})
	}
	r.agentHandles[h] = struct{}{}
	return h
}

func (a *Agents) namespace() (*agentNamespace, error) {
	if a == nil {
		return nil, agentJSONError(ErrInvalidState, "agent namespace is not initialized")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.native != nil {
		return a.native, nil
	}
	if a.box == nil || a.box.runtime == nil {
		return nil, agentJSONError(ErrInvalidState, "agent namespace has no Box")
	}
	box, unlock, err := a.box.acquire()
	if err != nil {
		return nil, err
	}
	defer unlock()
	r := a.box.runtime
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	if r.agentClosed || r.handle == nil {
		return nil, ErrRuntimeClosed
	}
	var ptr *C.struct_CAgents
	var cerr C.CBoxliteError
	if C.boxlite_box_agents(box, &ptr, &cerr) != C.Ok {
		return nil, freeError(&cerr)
	}
	a.native = registerAgentHandle(r, ptr, func(p *C.struct_CAgents) { C.boxlite_agents_free(p) })
	runtime.AddCleanup(a, func(h *agentNamespace) { h.release() }, a.native)
	return a.native, nil
}

func wrapAgent(h *agentSession) *Agent {
	a := &Agent{native: h}
	runtime.AddCleanup(a, func(h *agentSession) { h.release() }, h)
	return a
}
func wrapAgentTurn(h *agentTurnHandle) *AgentTurn {
	t := &AgentTurn{native: h}
	runtime.AddCleanup(t, func(h *agentTurnHandle) { h.release() }, h)
	return t
}
func agentSessionOf(a *Agent) *agentSession {
	if a == nil {
		return nil
	}
	return a.native
}
func agentTurnOf(t *AgentTurn) *agentTurnHandle {
	if t == nil {
		return nil
	}
	return t.native
}

type agentPending[T any] struct {
	owner  *Runtime
	result chan handleResult[T]
}

func agentCall[T any, P comparable](ctx context.Context, h *agentHandle[P], submit func(P, C.uintptr_t, *C.CBoxliteError) C.enum_BoxliteErrorCode, dispose func(T)) (T, error) {
	var zero T
	if ctx == nil {
		return zero, agentJSONError(ErrInvalidArgument, "nil context")
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	ptr, unlock, err := h.acquire()
	if err != nil {
		return zero, err
	}
	r := h.owner
	r.ensureDrainRunning()
	pending := &agentPending[T]{owner: r, result: make(chan handleResult[T], 1)}
	token := registerHandleForDispatch(cgo.NewHandle(pending))
	var cerr C.CBoxliteError
	code := submit(ptr, C.uintptr_t(token), &cerr)
	unlock()
	if code != C.Ok {
		deleteHandleForDispatch(token)
		return zero, freeError(&cerr)
	}
	discard := func(value T) {
		if dispose != nil {
			dispose(value)
		}
	}
	select {
	case result := <-pending.result:
		select {
		case <-r.closing:
			discard(result.value)
			return zero, ErrRuntimeClosed
		default:
		}
		if err := ctx.Err(); err != nil {
			discard(result.value)
			return zero, err
		}
		return result.value, result.err
	case <-ctx.Done():
		abandonOwnedResult(pending.result, token, discard)
		return zero, ctx.Err()
	case <-r.closing:
		abandonOwnedResult(pending.result, token, discard)
		return zero, ErrRuntimeClosed
	}
}

func agentGetter[T any, P comparable](h *agentHandle[P], get func(P, **C.char, *C.CBoxliteError) C.enum_BoxliteErrorCode, parse func([]byte) (T, error)) (T, error) {
	var zero T
	ptr, unlock, err := h.acquire()
	if err != nil {
		return zero, err
	}
	var json *C.char
	var cerr C.CBoxliteError
	code := get(ptr, &json, &cerr)
	unlock()
	if json != nil {
		defer C.boxlite_free_string(json)
	}
	if code != C.Ok {
		return zero, freeError(&cerr)
	}
	return parse([]byte(C.GoString(json)))
}

// Agent callback data is borrowed; freeError owns its input and cannot be
// reused here. Copy the message before Rust frees it after callback return.
func borrowedAgentError(err *C.CBoxliteError) error {
	if err == nil || err.code == C.Ok {
		return nil
	}
	return &Error{Code: ErrorCode(err.code), Message: cString(err.message)}
}

func agentHandleResult[P comparable](ptr P, err *C.CBoxliteError, token C.uintptr_t, free func(P)) {
	h := cgo.Handle(token)
	var zero P
	if !claimHandleForDispatch(h) {
		if ptr != zero {
			free(ptr)
		}
		return
	}
	defer h.Delete()
	op := h.Value().(*agentPending[*agentHandle[P]])
	result := handleResult[*agentHandle[P]]{err: borrowedAgentError(err)}
	if result.err == nil {
		if ptr == zero {
			result.err = agentJSONError(ErrInternal, "agent callback returned no handle")
		} else {
			result.value, result.err = adoptAgentHandle(op.owner, ptr, free)
		}
	} else if ptr != zero {
		free(ptr)
	}
	op.result <- result
}

//export goBoxliteAgentCreated
func goBoxliteAgentCreated(ptr *C.struct_CAgent, err *C.CBoxliteError, token C.uintptr_t) {
	agentHandleResult(ptr, err, token, func(p *C.struct_CAgent) { C.boxlite_agent_free(p) })
}

//export goBoxliteAgentTurn
func goBoxliteAgentTurn(ptr *C.struct_CAgentTurn, err *C.CBoxliteError, token C.uintptr_t) {
	agentHandleResult(ptr, err, token, func(p *C.struct_CAgentTurn) { C.boxlite_agent_turn_free(p) })
}

//export goBoxliteAgentJSON
func goBoxliteAgentJSON(json *C.char, err *C.CBoxliteError, token C.uintptr_t) {
	h := cgo.Handle(token)
	if !claimHandleForDispatch(h) {
		return
	}
	defer h.Delete()
	op := h.Value().(*agentPending[[]byte])
	var data []byte
	if json != nil {
		data = []byte(C.GoString(json))
	}
	op.result <- handleResult[[]byte]{value: data, err: borrowedAgentError(err)}
}

type agentArguments struct {
	strings []*C.char
	err     error
}

func (a *agentArguments) string(value, name string, optional bool) *C.char {
	if a.err != nil {
		return nil
	}
	if !utf8.ValidString(value) || strings.IndexByte(value, 0) >= 0 {
		a.err = agentJSONError(ErrInvalidArgument, name+" contains invalid UTF-8 or NUL")
		return nil
	}
	if optional && value == "" {
		return nil
	}
	ptr := toCString(value)
	a.strings = append(a.strings, ptr)
	return ptr
}
func (a *agentArguments) control(options AgentControlOptions) C.struct_CAgentControlOptions {
	return C.struct_CAgentControlOptions{idempotency_key: a.string(options.IdempotencyKey, "idempotency_key", true)}
}
func (a *agentArguments) free() {
	for _, ptr := range a.strings {
		C.free(unsafe.Pointer(ptr))
	}
}
