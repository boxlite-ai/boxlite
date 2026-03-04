// Package boxlite provides a Go SDK for the BoxLite runtime.
package boxlite

import (
	"errors"
	"fmt"
)

// ErrorCode represents a BoxLite error category.
type ErrorCode int

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
