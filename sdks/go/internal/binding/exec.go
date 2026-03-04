package binding

/*
#include <stdlib.h>

// Defined in exec_bridge.c — wraps boxlite_go_box_exec with the Go callback.
int call_box_exec_with_go_callback(
    void* handle,
    const char* command,
    const char* opts_json,
    void* user_data,
    int* out_exit_code,
    char** out_err
);
*/
import "C"
import (
	"encoding/json"
	"runtime/cgo"
	"sync"
	"unsafe"
)

// ExecOptions holds the configuration for executing a command.
type ExecOptions struct {
	Args       []string          `json:"args,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	TTY        bool              `json:"tty,omitempty"`
	User       string            `json:"user,omitempty"`
	TimeoutSec float64           `json:"timeout_secs,omitempty"`
	WorkingDir string            `json:"working_dir,omitempty"`
}

// ExecResult holds the result of a command execution.
type ExecResult struct {
	ExitCode int
	Stdout   []string
	Stderr   []string
}

// outputCollector gathers stdout/stderr lines from the C callback.
type outputCollector struct {
	mu     sync.Mutex
	stdout []string
	stderr []string
}

//export goOutputCallback
func goOutputCallback(text *C.char, streamType C.int, userData unsafe.Pointer) {
	h := cgo.Handle(userData)
	collector := h.Value().(*outputCollector)
	line := C.GoString(text)

	collector.mu.Lock()
	defer collector.mu.Unlock()

	if int(streamType) == 0 {
		collector.stdout = append(collector.stdout, line)
	} else {
		collector.stderr = append(collector.stderr, line)
	}
}

// Exec executes a command in the box and returns the result.
func (b *Box) Exec(command string, opts ExecOptions) (ExecResult, error) {
	cCommand := C.CString(command)
	defer C.free(unsafe.Pointer(cCommand))

	optsJSON, err := json.Marshal(opts)
	if err != nil {
		return ExecResult{}, err
	}
	cOptsJSON := C.CString(string(optsJSON))
	defer C.free(unsafe.Pointer(cOptsJSON))

	collector := &outputCollector{}
	h := cgo.NewHandle(collector)
	defer h.Delete()

	var exitCode C.int
	var outErr *C.char

	res := C.call_box_exec_with_go_callback(
		b.handle,
		cCommand,
		cOptsJSON,
		unsafe.Pointer(h),
		&exitCode,
		&outErr,
	)
	if res < 0 {
		return ExecResult{}, getError(outErr)
	}

	return ExecResult{
		ExitCode: int(exitCode),
		Stdout:   collector.stdout,
		Stderr:   collector.stderr,
	}, nil
}
