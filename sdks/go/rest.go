package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"unsafe"
)

// BoxliteRestOptions configures a REST-backed runtime created by
// NewRest. The name is intentionally identical across every SDK
// (C/Go/Node/Python) for cross-SDK parity; the boxlite.BoxliteRestOptions
// package stutter is accepted as a deliberate trade-off.
//
//nolint:revive
type BoxliteRestOptions struct {
	// URL is the REST API base URL (required, e.g.
	// "https://api.example.com").
	URL string

	// Credential authenticates requests. Nil = unauthenticated. Today
	// only *ApiKeyCredential is supported.
	Credential Credential

	// Prefix overrides the REST API path prefix (server default: "v1").
	Prefix string
}

// NewRest creates a runtime that connects to a remote BoxLite REST
// server at opts.URL instead of running boxes in-process.
//
// The returned *Runtime is identical to one from NewRuntime — every
// box, exec, copy, image, and metrics operation works against it
// unchanged; REST is just an alternative backend. The HTTP connection
// is lazy (established on the first operation), so NewRest itself does
// no network I/O.
//
//	rt, err := boxlite.NewRest(boxlite.BoxliteRestOptions{
//	        URL:        "https://api.example.com",
//	        Credential: boxlite.NewApiKeyCredential("blk_live_..."),
//	})
//	if err != nil { return err }
//	defer rt.Close()
func NewRest(opts BoxliteRestOptions) (*Runtime, error) {
	cURL := toCString(opts.URL)
	defer C.free(unsafe.Pointer(cURL))

	var cerr C.CBoxliteError
	var cOpts *C.CBoxliteRestOptions
	if code := C.boxlite_rest_options_new(cURL, &cOpts, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_rest_options_free(cOpts)

	if opts.Credential != nil {
		apiKey, ok := opts.Credential.(*ApiKeyCredential)
		if !ok {
			return nil, fmt.Errorf(
				"boxlite: unsupported Credential type %T (only *ApiKeyCredential is supported)",
				opts.Credential,
			)
		}
		cKey := toCString(apiKey.key)
		defer C.free(unsafe.Pointer(cKey))

		var cCred *C.CBoxliteCredential
		if code := C.boxlite_api_key_credential_new(cKey, &cCred, &cerr); code != C.Ok {
			return nil, freeError(&cerr)
		}
		defer C.boxlite_credential_free(cCred)
		C.boxlite_rest_options_set_credential(cOpts, cCred)
	}

	if opts.Prefix != "" {
		cPrefix := toCString(opts.Prefix)
		defer C.free(unsafe.Pointer(cPrefix))
		C.boxlite_rest_options_set_prefix(cOpts, cPrefix)
	}

	var handle *C.CBoxliteRuntime
	if code := C.boxlite_rest_runtime_new_with_options(cOpts, &handle, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Runtime{
		handle:  handle,
		closing: make(chan struct{}),
	}, nil
}
