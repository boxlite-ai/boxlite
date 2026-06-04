// Package boxlite provides a Go SDK for the BoxLite runtime.
package boxlite

import (
	"errors"
	"fmt"
)

// ErrorCode represents a BoxLite error category.
type ErrorCode int

// Error codes mirror the C SDK's BoxliteErrorCode enum
// (sdks/c/src/error.rs:21-67). Numeric values must stay in sync —
// the CGO bridge transmits the integer across the FFI boundary.
const (
	ErrInternal          ErrorCode = 1
	ErrNotFound          ErrorCode = 2
	ErrAlreadyExists     ErrorCode = 3
	ErrInvalidState      ErrorCode = 4
	ErrInvalidArgument   ErrorCode = 5
	ErrConfig            ErrorCode = 6
	ErrStorage           ErrorCode = 7
	ErrImage             ErrorCode = 8
	ErrNetwork           ErrorCode = 9
	ErrExecution         ErrorCode = 10
	ErrStopped           ErrorCode = 11
	ErrEngine            ErrorCode = 12
	ErrUnsupported       ErrorCode = 13
	ErrDatabase          ErrorCode = 14
	ErrPortal            ErrorCode = 15
	ErrRpc               ErrorCode = 16
	ErrRpcTransport      ErrorCode = 17
	ErrMetadata          ErrorCode = 18
	ErrUnsupportedEngine ErrorCode = 19
	// System resource limit reached (disk full, VM slot exhaustion).
	// Server-side HTTP 429.
	ErrResourceExhausted ErrorCode = 20
	// Interactive execution session was reaped server-side after
	// disconnect; reattach is no longer possible — start a new exec.
	// Server-side HTTP 410.
	ErrSessionReaped ErrorCode = 21
)

// Error is a typed error from the BoxLite runtime.
type Error struct {
	Code    ErrorCode
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("boxlite: %s (code=%d)", e.Message, e.Code)
}

// IsNotFound reports whether err indicates a not-found condition.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == ErrNotFound
}

// IsAlreadyExists reports whether err indicates a resource already exists.
func IsAlreadyExists(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == ErrAlreadyExists
}

// IsInvalidState reports whether err indicates an invalid state transition.
func IsInvalidState(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == ErrInvalidState
}

// IsStopped reports whether err indicates a stopped or shut down resource.
func IsStopped(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == ErrStopped
}

// ErrRuntimeClosed is returned by async operations when Runtime.Close is
// called while the operation is in flight. Callers select on r.closing
// alongside their result channel and ctx.Done(); when closing fires, the
// operation returns this sentinel rather than blocking forever waiting
// for a result that the now-dead drain goroutine cannot deliver.
var ErrRuntimeClosed = &Error{
	Code:    ErrInvalidState,
	Message: "runtime closed",
}
