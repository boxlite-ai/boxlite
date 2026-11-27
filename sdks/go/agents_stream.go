package boxlite

/*
#include "agents_bridge.h"
*/
import "C"

import (
	"context"
	"io"
	"runtime"
	"runtime/cgo"
	"sync"
	"unsafe"
)

const (
	agentStreamCount = 64
	agentStreamBytes = 4 * 1024 * 1024
)

// The runtime retains callback state until terminal delivery, and buffered
// records until the wrapper closes, becomes unreachable, or its runtime closes.
// Public wrappers can become unreachable without keeping the subscription open.
// No lock is held while invoking a native release or stopping a context watcher.
type agentSubscription struct {
	owner         *Runtime
	token         cgo.Handle
	mu            sync.Mutex
	ptr           *C.struct_CAgentEvents
	opened        bool
	terminal      bool
	retired       bool
	canceled      bool
	closed        bool
	reading       bool
	runtimeClosed bool
	openErr       error
	err           error
	queue         [][]byte
	bytes         int
	changed       chan struct{}
	openDone      chan struct{}
	done          chan struct{}
	ctx           context.Context
	stopWatch     func() bool
}
type agentEventStream struct{ state *agentSubscription }

func (s *agentSubscription) signalLocked()                      { close(s.changed); s.changed = make(chan struct{}) }
func (s *agentSubscription) takeLocked() *C.struct_CAgentEvents { p := s.ptr; s.ptr = nil; return p }
func freeAgentEvents(p *C.struct_CAgentEvents) {
	if p != nil {
		C.boxlite_agent_events_free(p)
	}
}
func (s *agentSubscription) stopWatching() {
	s.mu.Lock()
	stop := s.stopWatch
	s.stopWatch = nil
	s.ctx = nil
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
}
func (s *agentSubscription) watch(ctx context.Context) {
	stop := context.AfterFunc(ctx, func() { s.cancel(ctx.Err()) })
	s.mu.Lock()
	if s.terminal || s.closed || s.runtimeClosed {
		s.mu.Unlock()
		stop()
		return
	}
	s.stopWatch = stop
	s.mu.Unlock()
}
func (s *agentSubscription) cancel(err error) {
	s.mu.Lock()
	if s.terminal || s.closed || s.runtimeClosed {
		s.mu.Unlock()
		return
	}
	if s.err == nil {
		s.err = err
	}
	s.canceled = true
	p := s.takeLocked()
	s.signalLocked()
	s.mu.Unlock()
	freeAgentEvents(p)
}
func (s *agentSubscription) close() {
	s.mu.Lock()
	s.closed = true
	s.canceled = true
	s.queue = nil
	s.bytes = 0
	p := s.takeLocked()
	s.signalLocked()
	s.mu.Unlock()
	s.stopWatching()
	freeAgentEvents(p)
	s.forgetBuffer()
}
func (s *agentSubscription) shutdown() {
	s.mu.Lock()
	s.runtimeClosed = true
	s.canceled = true
	s.queue = nil
	s.bytes = 0
	p := s.takeLocked()
	s.signalLocked()
	s.mu.Unlock()
	s.stopWatching()
	freeAgentEvents(p)
	s.forgetBuffer()
}
func (s *agentSubscription) forgetBuffer() {
	s.owner.agentStreamsMu.Lock()
	delete(s.owner.agentBuffers, s)
	s.owner.agentStreamsMu.Unlock()
}
func (s *agentSubscription) retire() {
	s.mu.Lock()
	if s.retired {
		s.mu.Unlock()
		return
	}
	s.retired = true
	forget := s.closed || s.runtimeClosed || s.openErr != nil
	s.mu.Unlock()
	s.owner.agentStreamsMu.Lock()
	delete(s.owner.agentStreams, uintptr(s.token))
	s.owner.agentStreamsMu.Unlock()
	if forget {
		s.forgetBuffer()
	}
	s.token.Delete()
	close(s.done)
}
func (s *agentSubscription) finish(err error) {
	s.mu.Lock()
	s.terminal = true
	if s.err == nil && !s.closed {
		s.err = err
		if err == nil && s.ctx != nil {
			s.err = s.ctx.Err()
		}
	}
	p := s.takeLocked()
	s.signalLocked()
	s.mu.Unlock()
	s.stopWatching()
	freeAgentEvents(p)
	s.retire()
}
func (s *agentSubscription) runtimeEnded() {
	s.shutdown()
	s.mu.Lock()
	s.terminal = true
	s.mu.Unlock()
	s.retire()
}
func runtimeAgentClosed(r *Runtime) bool {
	select {
	case <-r.closing:
		return true
	default:
		return false
	}
}

func openAgentEvents[P comparable](ctx context.Context, h *agentHandle[P], options AgentEventsOptions, submit func(P, *C.struct_CAgentEventsOptions, C.uintptr_t, *C.CBoxliteError) C.enum_BoxliteErrorCode) (AgentEventStream, error) {
	if err := agentContextError(ctx); err != nil {
		return nil, err
	}
	var args agentArguments
	defer args.free()
	opts := C.struct_CAgentEventsOptions{after: args.string(options.After, "after", true)}
	if args.err != nil {
		return nil, args.err
	}
	p, unlock, err := h.acquire()
	if err != nil {
		return nil, err
	}
	r := h.owner
	s := &agentSubscription{owner: r, changed: make(chan struct{}), openDone: make(chan struct{}), done: make(chan struct{}), ctx: ctx}
	s.token = cgo.NewHandle(s)
	r.agentStreamsMu.Lock()
	if r.agentStreams == nil {
		r.agentStreams = make(map[uintptr]*agentSubscription)
	}
	if r.agentBuffers == nil {
		r.agentBuffers = make(map[*agentSubscription]struct{})
	}
	r.agentStreams[uintptr(s.token)] = s
	r.agentBuffers[s] = struct{}{}
	r.agentStreamsMu.Unlock()
	s.watch(ctx)
	r.ensureDrainRunning()
	var cerr C.CBoxliteError
	code := submit(p, &opts, C.uintptr_t(s.token), &cerr)
	unlock()
	if code != C.Ok {
		s.close()
		s.finish(nil)
		return nil, freeError(&cerr)
	}
	select {
	case <-s.openDone:
		if runtimeAgentClosed(r) {
			s.shutdown()
			return nil, ErrRuntimeClosed
		}
		if err := ctx.Err(); err != nil {
			s.cancel(err)
			s.close()
			return nil, err
		}
		s.mu.Lock()
		err := s.openErr
		s.mu.Unlock()
		if err != nil {
			return nil, err
		}
		stream := &agentEventStream{state: s}
		runtime.AddCleanup(stream, func(state *agentSubscription) { state.close() }, s)
		return stream, nil
	case <-ctx.Done():
		s.cancel(ctx.Err())
		s.close()
		return nil, ctx.Err()
	case <-r.closing:
		s.shutdown()
		return nil, ErrRuntimeClosed
	}
}
func (a *Agent) Events(ctx context.Context, options AgentEventsOptions) (AgentEventStream, error) {
	defer runtime.KeepAlive(a)
	return openAgentEvents(ctx, agentSessionOf(a), options, func(p *C.struct_CAgent, o *C.struct_CAgentEventsOptions, t C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_events(p, o, t, e)
	})
}
func (t *AgentTurn) Events(ctx context.Context, options AgentEventsOptions) (AgentEventStream, error) {
	defer runtime.KeepAlive(t)
	return openAgentEvents(ctx, agentTurnOf(t), options, func(p *C.struct_CAgentTurn, o *C.struct_CAgentEventsOptions, t C.uintptr_t, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.go_agent_turn_events(p, o, t, e)
	})
}

func (stream *agentEventStream) Close() error {
	defer runtime.KeepAlive(stream)
	stream.state.close()
	return nil
}

// Shutdown takes precedence when both cancellation signals are observable.
func (s *agentSubscription) readContextErrorLocked(ctx context.Context) error {
	readErr := ctx.Err()
	if s.runtimeClosed || runtimeAgentClosed(s.owner) {
		return ErrRuntimeClosed
	}
	return readErr
}

func (stream *agentEventStream) Next(ctx context.Context) (*AgentEvent, error) {
	defer runtime.KeepAlive(stream)
	if ctx == nil {
		return nil, agentJSONError(ErrInvalidArgument, "nil context")
	}
	s := stream.state
	s.mu.Lock()
	if err := s.readContextErrorLocked(ctx); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if s.reading {
		s.mu.Unlock()
		return nil, agentJSONError(ErrInvalidState, "concurrent event reader")
	}
	s.reading = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.reading = false; s.mu.Unlock() }()
	for {
		s.mu.Lock()
		if err := s.readContextErrorLocked(ctx); err != nil {
			s.mu.Unlock()
			return nil, err
		}
		if len(s.queue) > 0 {
			raw := s.queue[0]
			s.queue[0] = nil
			s.queue = s.queue[1:]
			s.bytes -= len(raw)
			s.mu.Unlock()
			return parseAgentEvent(raw)
		}
		if s.err != nil {
			err := s.err
			s.mu.Unlock()
			return nil, err
		}
		if s.terminal || s.closed {
			s.mu.Unlock()
			return nil, io.EOF
		}
		changed := s.changed
		s.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
		case <-s.owner.closing:
		}
	}
}

//export goBoxliteAgentOpened
func goBoxliteAgentOpened(ptr *C.struct_CAgentEvents, cerr *C.CBoxliteError, token C.uintptr_t) {
	s := cgo.Handle(token).Value().(*agentSubscription)
	err := borrowedAgentError(cerr)
	if ptr == nil && err == nil {
		err = agentJSONError(ErrInternal, "event opening returned no handle")
	}
	s.mu.Lock()
	s.opened = ptr != nil
	s.ptr = ptr
	s.openErr = err
	if runtimeAgentClosed(s.owner) {
		s.runtimeClosed = true
		s.canceled = true
	}
	if s.ctx != nil && s.ctx.Err() != nil && !s.closed && !s.terminal {
		if s.err == nil {
			s.err = s.ctx.Err()
		}
		s.canceled = true
	}
	var release *C.struct_CAgentEvents
	if s.canceled {
		release = s.takeLocked()
	}
	close(s.openDone)
	s.signalLocked()
	s.mu.Unlock()
	freeAgentEvents(release)
	if err != nil {
		s.finish(err)
	}
}

//export goBoxliteAgentEvent
func goBoxliteAgentEvent(json *C.char, cerr *C.CBoxliteError, token C.uintptr_t) {
	s := cgo.Handle(token).Value().(*agentSubscription)
	if json == nil {
		s.finish(borrowedAgentError(cerr))
		return
	}
	s.mu.Lock()
	if s.canceled || s.closed || s.terminal || s.runtimeClosed {
		s.mu.Unlock()
		return
	}
	// Admission precedes Go allocation; oversized borrowed records are never copied.
	length := int(C.go_agent_event_length(json, C.size_t(agentStreamBytes)))
	if len(s.queue) >= agentStreamCount || length > agentStreamBytes-s.bytes {
		if s.err == nil {
			s.err = agentJSONError(ErrResourceExhausted, "agent event buffer exhausted")
		}
		s.canceled = true
		p := s.takeLocked()
		s.signalLocked()
		s.mu.Unlock()
		freeAgentEvents(p)
		return
	}
	s.queue = append(s.queue, C.GoBytes(unsafe.Pointer(json), C.int(length)))
	s.bytes += length
	s.signalLocked()
	s.mu.Unlock()
}

func (r *Runtime) agentStreamSnapshot() []*agentSubscription {
	r.agentStreamsMu.Lock()
	defer r.agentStreamsMu.Unlock()
	streams := make([]*agentSubscription, 0, len(r.agentStreams))
	for _, s := range r.agentStreams {
		streams = append(streams, s)
	}
	return streams
}
func (r *Runtime) agentBufferSnapshot() []*agentSubscription {
	r.agentStreamsMu.Lock()
	defer r.agentStreamsMu.Unlock()
	streams := make([]*agentSubscription, 0, len(r.agentBuffers))
	for s := range r.agentBuffers {
		streams = append(streams, s)
	}
	return streams
}
func (r *Runtime) connectedAgentStreams() int {
	n := 0
	for _, s := range r.agentStreamSnapshot() {
		s.mu.Lock()
		if s.opened && !s.terminal {
			n++
		}
		s.mu.Unlock()
	}
	return n
}

// Called only after the ordinary drainer has joined. Pending native connects
// without a transferred handle remain C-owned and do not delay runtime free.
func (r *Runtime) drainAgentTerminals() {
	for r.connectedAgentStreams() > 0 {
		C.boxlite_go_drain_subscription(r.handle, C.int(drainTimeoutMs))
	}
}
