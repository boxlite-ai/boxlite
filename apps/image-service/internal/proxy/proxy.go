// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package proxy holds what only the registry proxy needs: who is calling, what
// they are allowed to reach, how often, and where an upstream redirect may
// point. The protocol it speaks while doing that is internal/oci.
package proxy

import "errors"

// ErrNotRoutable means a repository name does not carry the org, upstream host
// and repository that the registry proxy routes by.
var ErrNotRoutable = errors.New("repository name is not routable")
