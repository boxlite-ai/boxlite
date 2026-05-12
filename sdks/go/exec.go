package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"bytes"
	"context"
	"io"
	"runtime/cgo"
	"sort"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// ExecResult contains the result of a buffered command execution.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// envMapToFlatPairs flattens an env map into a [k0, v0, k1, v1, ...]
// slice sorted by key. Sorting makes the C call deterministic across
// runs, which matters for test reproducibility and for any downstream
// hashing the runtime might do over the pairs.
func envMapToFlatPairs(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, 2*len(env))
	for _, k := range keys {
		pairs = append(pairs, k, env[k])
	}
	return pairs
}

// envMapToCStringArray converts an env map to a C string array suitable
// for `BoxliteCommand.env_pairs`. Returns (nil, 0) for nil/empty input.
// Caller must free via freeCStringArray.
func envMapToCStringArray(env map[string]string) (**C.char, int) {
	return toCStringArray(envMapToFlatPairs(env))
}

// ExecutionOptions configures a streaming command execution.
type ExecutionOptions struct {
	TTY      bool
	Stdout   io.Writer
	Stderr   io.Writer
	OnStdout func([]byte)
	OnStderr func([]byte)
	// Env is the environment given to the executed process. nil/empty
	// inherits the container default. The map is serialised into a flat
	// [k0, v0, k1, v1, ...] C array in deterministic key order.
	Env map[string]string
	// WorkingDir is the directory the process starts in. Empty inherits
	// the container default.
	WorkingDir string
	// Timeout bounds the wall-clock lifetime of the execution. Zero
	// means no timeout (the C side treats `timeout_secs <= 0` as
	// unbounded — see `sdks/c/src/exec/command.rs`).
	Timeout time.Duration
}

// executionStreamState holds the user-provided sinks for streaming output
// plus a "released" flag. A single instance is shared between the stdout,
// stderr, and exit callback registrations on the C side.
//
// Lifetime: the cgo.Handle wrapping this state is intentionally leaked for
// the lifetime of the Runtime. Stream events (stdout/stderr) and the exit
// event are pushed concurrently by independent Rust pumps with no global
// ordering guarantee between them, so deleting the handle from any one
// callback could race a sibling callback's value lookup. The released
// flag short-circuits any post-exit stream events that still arrive.
//
// Memory overhead is bounded: each execution adds one map entry plus the
// state struct (a few writers, two atomics, and a mutex).
type executionStreamState struct {
	mu       sync.Mutex
	stdout   io.Writer
	stderr   io.Writer
	onStdout func([]byte)
	onStderr func([]byte)

	released atomic.Bool
}

func newExecutionStreamState(opts ExecutionOptions) *executionStreamState {
	return &executionStreamState{
		stdout:   opts.Stdout,
		stderr:   opts.Stderr,
		onStdout: opts.OnStdout,
		onStderr: opts.OnStderr,
	}
}

func (s *executionStreamState) deliverStdout(data []byte) {
	if s.released.Load() {
		return
	}
	s.mu.Lock()
	stdout := s.stdout
	cb := s.onStdout
	s.mu.Unlock()
	if cb != nil {
		cb(data)
	}
	if stdout != nil {
		_, _ = stdout.Write(data)
	}
}

func (s *executionStreamState) deliverStderr(data []byte) {
	if s.released.Load() {
		return
	}
	s.mu.Lock()
	stderr := s.stderr
	cb := s.onStderr
	s.mu.Unlock()
	if cb != nil {
		cb(data)
	}
	if stderr != nil {
		_, _ = stderr.Write(data)
	}
}

func (s *executionStreamState) deliverExit(_ int) {
	s.released.Store(true)
}

func (s *executionStreamState) markReleased() {
	s.released.Store(true)
}

// Execution is a handle to a running command.
type Execution struct {
	handle      *C.CExecutionHandle
	streamState *executionStreamState
	// closing is the parent runtime's close-broadcast channel; Wait/Kill/
	// ResizeTTY select on it so they unblock when Runtime.Close is called
	// while they're parked on their result channel.
	closing <-chan struct{}

	// Stdin writes bytes to the running command's standard input. Closing it
	// signals EOF to the guest process — the analog of `os/exec.Cmd.StdinPipe()`'s
	// io.WriteCloser. After Close(), subsequent Write calls return ErrInvalidState.
	Stdin io.WriteCloser

	closeOnce sync.Once
}

type executionStdin struct {
	execution *Execution
}

// Exec executes a command and returns the buffered result.
func (b *Box) Exec(ctx context.Context, name string, arg ...string) (*ExecResult, error) {
	cmd := b.Command(name, arg...)

	var stdoutBuf, stderrBuf []byte
	execution, err := b.StartExecution(ctx, cmd.Path, cmd.Args, &ExecutionOptions{
		Stdout: &bytesCollector{buf: &stdoutBuf},
		Stderr: &bytesCollector{buf: &stderrBuf},
	})
	if err != nil {
		return nil, err
	}
	defer execution.Close()

	exitCode, err := execution.Wait(ctx)
	if err != nil {
		return nil, err
	}

	return &ExecResult{
		ExitCode: exitCode,
		Stdout:   string(stdoutBuf),
		Stderr:   string(stderrBuf),
	}, nil
}

// StartExecution starts a command and returns a streaming execution handle.
//
// boxlite_box_exec is synchronous on the C side; once it returns, we
// register stream callbacks (which post events into the runtime queue).
func (b *Box) StartExecution(_ context.Context, name string, args []string, opts *ExecutionOptions) (*Execution, error) {
	b.runtime.ensureDrainRunning()

	cCmd := toCString(name)
	defer C.free(unsafe.Pointer(cCmd))

	cArgs, argc := toCStringArray(args)
	defer freeCStringArray(cArgs, argc)

	cfg := ExecutionOptions{}
	if opts != nil {
		cfg = *opts
	}

	envPairs, envCount := envMapToCStringArray(cfg.Env)
	defer freeCStringArray(envPairs, envCount)

	var cWorkdir *C.char
	if cfg.WorkingDir != "" {
		cWorkdir = toCString(cfg.WorkingDir)
		defer C.free(unsafe.Pointer(cWorkdir))
	}

	cCommand := C.BoxliteCommand{
		command:      cCmd,
		args:         cArgs,
		argc:         C.int(argc),
		env_pairs:    envPairs,
		env_count:    C.int(envCount),
		workdir:      cWorkdir,
		user:         nil,
		timeout_secs: C.double(cfg.Timeout.Seconds()),
		tty:          boolToCInt(cfg.TTY),
	}

	var handle *C.CExecutionHandle
	var cerr C.CBoxliteError
	code := C.boxlite_box_exec(b.handle, &cCommand, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	state := newExecutionStreamState(cfg)
	streamHandle := cgo.NewHandle(state)

	if err := registerExecutionCallbacks(handle, streamHandle); err != nil {
		// On registration failure free the C handle (this aborts any pumps
		// already started) and mark the stream state released so any
		// remaining in-flight events short-circuit. We deliberately leak
		// the cgo.Handle here: deleting it could race with a stream
		// callback that has already entered drain and looked up the value.
		state.markReleased()
		C.boxlite_execution_free(handle)
		return nil, err
	}

	execution := &Execution{
		handle:      handle,
		streamState: state,
		closing:     b.runtime.closing,
	}
	execution.Stdin = &executionStdin{execution: execution}
	return execution, nil
}

// registerExecutionCallbacks wires stdout, stderr, and exit on the C side
// using a single shared cgo.Handle so the exit callback (dispatched last)
// can Delete it without racing the stream callbacks.
func registerExecutionCallbacks(handle *C.CExecutionHandle, streamHandle cgo.Handle) error {
	udPtr := handleToPtr(streamHandle)

	var cerr C.CBoxliteError
	if code := C.boxlite_execution_on_stdout(handle, C.cbStdout(), udPtr, &cerr); code != C.Ok {
		return freeError(&cerr)
	}
	if code := C.boxlite_execution_on_stderr(handle, C.cbStderr(), udPtr, &cerr); code != C.Ok {
		return freeError(&cerr)
	}
	if code := C.boxlite_execution_on_exit(handle, C.cbExit(), udPtr, &cerr); code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Write writes bytes to the running command's standard input.
func (e *Execution) Write(p []byte) (int, error) {
	if e.Stdin == nil {
		return 0, &Error{Code: ErrInvalidState, Message: "execution stdin is closed"}
	}
	return e.Stdin.Write(p)
}

// Wait waits for the command to finish and returns its exit code.
//
// boxlite_execution_wait runs as its own async task on the C side and
// pushes a wait completion event into the runtime queue, dispatched here
// by the drain goroutine.
func (e *Execution) Wait(ctx context.Context) (int, error) {
	if e.handle == nil {
		return 0, &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	ch := make(chan executionWaitResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_execution_wait(e.handle, C.cbExecutionWait(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return 0, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.exitCode, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, e.closing)
		return 0, ctx.Err()
	case <-e.closing:
		drainAndDelete(ch, h, e.closing)
		return 0, ErrRuntimeClosed
	}
}

// Kill terminates the running command.
func (e *Execution) Kill(ctx context.Context) error {
	if e.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_execution_kill(e.handle, C.cbExecutionKill(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, e.closing)
		return ctx.Err()
	case <-e.closing:
		abandonAsyncErr(ch, h, e.closing)
		return ErrRuntimeClosed
	}
}

// Signal sends an arbitrary Unix signal (e.g. 1=SIGHUP, 2=SIGINT, 15=SIGTERM)
// to the running command. Use Kill for SIGKILL+evict semantics; Signal is
// for graceful and non-terminal signals that should not tear down the
// per-execution bookkeeping.
//
// `sig` must be in the range 1..=64 (1..=31 standard, 32..=64 RT). Out-of-
// range values are rejected synchronously (no FFI call) so an invalid
// signal can never reach the Rust runtime. Range validation runs BEFORE
// the closed-handle check so callers that pass an invalid signal always
// receive `ErrInvalidArgument` regardless of handle state.
func (e *Execution) Signal(ctx context.Context, sig int) error {
	if sig < 1 || sig > 64 {
		return &Error{
			Code:    ErrInvalidArgument,
			Message: "signal must be in 1..=64",
		}
	}
	if e.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_execution_signal(
		e.handle,
		C.int(sig),
		C.cbExecutionSignal(),
		handleToPtr(h),
		&cerr,
	)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, e.closing)
		return ctx.Err()
	case <-e.closing:
		abandonAsyncErr(ch, h, e.closing)
		return ErrRuntimeClosed
	}
}

// ResizeTTY changes the terminal size for TTY-enabled executions.
func (e *Execution) ResizeTTY(ctx context.Context, rows, cols int) error {
	if e.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_execution_tty_resize(e.handle, C.int(rows), C.int(cols), C.cbExecutionResize(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, e.closing)
		return ctx.Err()
	case <-e.closing:
		abandonAsyncErr(ch, h, e.closing)
		return ErrRuntimeClosed
	}
}

// Close releases the execution handle and signals the stream state that
// no further deliveries are expected. The cgo.Handle backing the stream
// state is intentionally not Deleted here (see executionStreamState for
// rationale).
func (e *Execution) Close() error {
	e.closeOnce.Do(func() {
		if e.streamState != nil {
			e.streamState.markReleased()
		}
		if e.handle != nil {
			C.boxlite_execution_free(e.handle)
			e.handle = nil
		}
	})
	return nil
}

func (s *executionStdin) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if s.execution == nil || s.execution.handle == nil {
		return 0, &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	var cerr C.CBoxliteError
	code := C.boxlite_execution_stdin_write(
		s.execution.handle,
		(*C.uint8_t)(unsafe.Pointer(&p[0])),
		C.size_t(len(p)),
		&cerr,
	)
	if code != C.Ok {
		return 0, freeError(&cerr)
	}
	return len(p), nil
}

// Close signals EOF to the guest process's stdin. Idempotent: a second call
// is a no-op. Mirrors `os/exec.Cmd.StdinPipe()`'s io.WriteCloser contract.
func (s *executionStdin) Close() error {
	if s.execution == nil || s.execution.handle == nil {
		return nil
	}
	var cerr C.CBoxliteError
	code := C.boxlite_execution_stdin_close(s.execution.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Command creates a Cmd for streaming execution, mirroring os/exec.Cmd.
func (b *Box) Command(name string, arg ...string) *Cmd {
	return &Cmd{
		Path: name,
		Args: arg,
		box:  b,
	}
}

// Cmd represents a command to execute inside a box.
// It mirrors the os/exec.Cmd pattern: callers configure Env/Dir/Timeout
// on the struct before invoking Run/Output/CombinedOutput. Zero-value
// fields inherit the container default — same semantics as os/exec.Cmd
// with the addition of Timeout, which bounds wall-clock lifetime
// (zero = unbounded, matching the C-FFI's `timeout_secs <= 0` convention).
type Cmd struct {
	Path   string
	Args   []string
	Stdout io.Writer
	Stderr io.Writer
	// Env is the environment of the executed process. nil/empty inherits
	// the container default.
	Env map[string]string
	// Dir is the working directory inside the container. Empty inherits
	// the container default. Named Dir (not WorkingDir) to match os/exec.
	Dir string
	// Timeout bounds wall-clock lifetime. Zero = no timeout.
	Timeout time.Duration

	box      *Box
	exitCode int
	done     bool
}

// Run executes the command. If Stdout/Stderr are set, output is streamed to them.
func (c *Cmd) Run(ctx context.Context) error {
	execution, err := c.box.StartExecution(ctx, c.Path, c.Args, &ExecutionOptions{
		Stdout:     c.Stdout,
		Stderr:     c.Stderr,
		Env:        c.Env,
		WorkingDir: c.Dir,
		Timeout:    c.Timeout,
	})
	if err != nil {
		return err
	}
	defer execution.Close()

	exitCode, err := execution.Wait(ctx)
	if err != nil {
		return err
	}

	c.exitCode = exitCode
	c.done = true
	return nil
}

// Output runs the command and returns its standard output.
func (c *Cmd) Output(ctx context.Context) ([]byte, error) {
	var buf bytes.Buffer
	c.Stdout = &buf
	err := c.Run(ctx)
	return buf.Bytes(), err
}

// CombinedOutput runs the command and returns combined stdout and stderr.
func (c *Cmd) CombinedOutput(ctx context.Context) ([]byte, error) {
	var buf bytes.Buffer
	c.Stdout = &buf
	c.Stderr = &buf
	err := c.Run(ctx)
	return buf.Bytes(), err
}

// ExitCode returns the exit code of the command. Only valid after Run completes.
func (c *Cmd) ExitCode() int {
	return c.exitCode
}

type bytesCollector struct {
	buf *[]byte
}

func (w *bytesCollector) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}
