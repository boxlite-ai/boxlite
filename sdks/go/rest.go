package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import "unsafe"

// RestOption configures a REST-backed runtime created by NewRest.
type RestOption func(*restConfig)

type restConfig struct {
	apiKey string
	prefix string
}

// WithApiKey sets the opaque API key sent as `Authorization: Bearer`.
// Omit it for an unauthenticated runtime.
func WithApiKey(key string) RestOption {
	return func(c *restConfig) { c.apiKey = key }
}

// WithPrefix overrides the REST API path prefix (server default: "v1").
func WithPrefix(prefix string) RestOption {
	return func(c *restConfig) { c.prefix = prefix }
}

// NewRest creates a runtime that connects to a remote BoxLite REST
// server at url instead of running boxes in-process.
//
// The returned *Runtime is identical to one from NewRuntime — every
// box, exec, copy, image, and metrics operation works against it
// unchanged; REST is just an alternative backend. The HTTP connection
// is lazy (established on the first operation), so NewRest itself does
// no network I/O.
//
//	rt, err := boxlite.NewRest("https://api.example.com",
//	        boxlite.WithApiKey("blk_live_..."))
//	if err != nil { return err }
//	defer rt.Close()
func NewRest(url string, opts ...RestOption) (*Runtime, error) {
	cfg := &restConfig{}
	for _, o := range opts {
		o(cfg)
	}

	cURL := toCString(url)
	defer C.free(unsafe.Pointer(cURL))

	// api_key / prefix are optional: a nil *C.char tells the C ABI to
	// skip them (unauthenticated / server-default prefix).
	var cAPIKey *C.char
	if cfg.apiKey != "" {
		cAPIKey = toCString(cfg.apiKey)
		defer C.free(unsafe.Pointer(cAPIKey))
	}
	var cPrefix *C.char
	if cfg.prefix != "" {
		cPrefix = toCString(cfg.prefix)
		defer C.free(unsafe.Pointer(cPrefix))
	}

	var handle *C.CBoxliteRuntime
	var cerr C.CBoxliteError
	code := C.boxlite_rest_runtime_new(cURL, cAPIKey, cPrefix, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Runtime{
		handle:  handle,
		closing: make(chan struct{}),
	}, nil
}
