// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package oci speaks the OCI distribution protocol and nothing else: how a
// pull spells itself in a URL, which endpoint serves a registry host, and how
// to issue that pull upstream.
//
// It does not know that its caller authenticates anyone, rate-limits anything,
// or is a proxy at all. Those belong to internal/proxy. Holding that line is
// what lets a second caller reuse this package without inheriting the registry
// proxy's request model.
package oci

import "errors"

// Callers distinguish these with errors.Is to decide what to answer a client;
// this package does not pick HTTP status codes.
var (
	// ErrNotPullPath means the URL is not addressed to a pull endpoint at all.
	ErrNotPullPath = errors.New("not an OCI pull path")
	// ErrInvalidName means the repository name breaks the distribution grammar.
	ErrInvalidName = errors.New("invalid repository name")
	// ErrInvalidReference means the tag or digest breaks the distribution grammar.
	ErrInvalidReference = errors.New("invalid reference")
	// ErrInvalidHost means the registry host is not a usable URI authority.
	ErrInvalidHost = errors.New("invalid registry host")
	// ErrUnsupportedMethod means the HTTP method is not one a pull may use.
	ErrUnsupportedMethod = errors.New("unsupported method")
)
