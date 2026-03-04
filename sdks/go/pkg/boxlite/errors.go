package client

import "errors"

// Common errors returned by the SDK.
var (
	// ErrBridgeNotReady is returned when the Go-Rust bridge is not working.
	ErrBridgeNotReady = errors.New("boxlite: bridge not ready")

	// ErrBoxNotFound is returned when a box with the given ID or name is not found.
	ErrBoxNotFound = errors.New("boxlite: box not found")
)
