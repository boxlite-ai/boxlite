package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>

extern void goBoxliteOutputCallback(char* text, int is_stderr, void* user_data);
*/
import "C"
import (
	"bytes"
	"context"
	"io"
	"runtime/cgo"
	"unsafe"
)

// ExecResult contains the result of a buffered command execution.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// ExecutionOptions configures a streaming command execution.
type ExecutionOptions struct {
	TTY      bool
	Stdout   io.Writer
	Stderr   io.Writer
	OnStdout func([]byte)
	OnStderr func([]byte)
}

// Execution is a handle to a running command.
type Execution struct {
	handle            *C.CExecutionHandle
	callbackHandle    cgo.Handle
	hasCallbackHandle bool

	// Stdin writes bytes to the running command's standard input.
	Stdin io.Writer
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
func (b *Box) StartExecution(_ context.Context, name string, args []string, opts *ExecutionOptions) (*Execution, error) {
	cCmd := toCString(name)
	defer C.free(unsafe.Pointer(cCmd))

	cArgs, argc := toCStringArray(args)
	defer freeCStringArray(cArgs, argc)

	cfg := ExecutionOptions{}
	if opts != nil {
		cfg = *opts
	}

	cCommand := C.BoxliteCommand{
		command:      cCmd,
		args:         cArgs,
		argc:         C.int(argc),
		env_pairs:    nil,
		env_count:    0,
		workdir:      nil,
		user:         nil,
		timeout_secs: 0,
		tty:          boolToCInt(cfg.TTY),
	}

	var callback *[0]byte
	var userData unsafe.Pointer
	var callbackHandle cgo.Handle
	hasCallbackHandle := cfg.Stdout != nil || cfg.Stderr != nil || cfg.OnStdout != nil || cfg.OnStderr != nil
	if hasCallbackHandle {
		writers := &callbackWriters{
			stdout:   cfg.Stdout,
			stderr:   cfg.Stderr,
			onStdout: cfg.OnStdout,
			onStderr: cfg.OnStderr,
		}
		callbackHandle = cgo.NewHandle(writers)
		callback = (*[0]byte)(C.goBoxliteOutputCallback)
		userData = handleToPtr(callbackHandle)
	}

	var handle *C.CExecutionHandle
	var cerr C.CBoxliteError
	code := C.boxlite_execute(
		b.handle,
		&cCommand,
		callback,
		userData,
		&handle,
		&cerr,
	)
	if code != C.Ok {
		if hasCallbackHandle {
			callbackHandle.Delete()
		}
		return nil, freeError(&cerr)
	}

	execution := &Execution{
		handle:            handle,
		callbackHandle:    callbackHandle,
		hasCallbackHandle: hasCallbackHandle,
	}
	execution.Stdin = &executionStdin{execution: execution}
	return execution, nil
}

// Write writes bytes to the running command's standard input.
func (e *Execution) Write(p []byte) (int, error) {
	if e.Stdin == nil {
		return 0, &Error{Code: ErrInvalidState, Message: "execution stdin is closed"}
	}
	return e.Stdin.Write(p)
}

// Wait waits for the command to finish and returns its exit code.
func (e *Execution) Wait(_ context.Context) (int, error) {
	if e.handle == nil {
		return 0, &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	var exitCode C.int
	var cerr C.CBoxliteError
	code := C.boxlite_execution_wait(e.handle, &exitCode, &cerr)
	e.releaseCallback()
	if code != C.Ok {
		return 0, freeError(&cerr)
	}

	return int(exitCode), nil
}

// Kill terminates the running command.
func (e *Execution) Kill(_ context.Context) error {
	if e.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	var cerr C.CBoxliteError
	code := C.boxlite_execution_kill(e.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// ResizeTTY changes the terminal size for TTY-enabled executions.
func (e *Execution) ResizeTTY(_ context.Context, rows, cols int) error {
	if e.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	var cerr C.CBoxliteError
	code := C.boxlite_execution_resize_tty(e.handle, C.int(rows), C.int(cols), &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Close releases the execution handle.
func (e *Execution) Close() error {
	if e.handle != nil {
		C.boxlite_execution_free(e.handle)
		e.handle = nil
	}
	e.releaseCallback()
	return nil
}

func (e *Execution) releaseCallback() {
	if e.hasCallbackHandle {
		e.callbackHandle.Delete()
		e.hasCallbackHandle = false
	}
}

func (s *executionStdin) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if s.execution == nil || s.execution.handle == nil {
		return 0, &Error{Code: ErrInvalidState, Message: "execution is closed"}
	}

	var cerr C.CBoxliteError
	code := C.boxlite_execution_write(
		s.execution.handle,
		(*C.char)(unsafe.Pointer(&p[0])),
		C.int(len(p)),
		&cerr,
	)
	if code != C.Ok {
		return 0, freeError(&cerr)
	}
	return len(p), nil
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
// It mirrors the os/exec.Cmd pattern.
type Cmd struct {
	Path   string
	Args   []string
	Stdout io.Writer
	Stderr io.Writer

	box      *Box
	exitCode int
	done     bool
}

// Run executes the command. If Stdout/Stderr are set, output is streamed to them.
func (c *Cmd) Run(ctx context.Context) error {
	execution, err := c.box.StartExecution(ctx, c.Path, c.Args, &ExecutionOptions{
		Stdout: c.Stdout,
		Stderr: c.Stderr,
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

func handleToPtr(h cgo.Handle) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&h))
}

type bytesCollector struct {
	buf *[]byte
}

func (w *bytesCollector) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}
