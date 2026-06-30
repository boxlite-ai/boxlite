// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package drain

import "sync/atomic"

var (
	draining     atomic.Bool
	activeAttach atomic.Int64
)

func Enable() {
	draining.Store(true)
}

func Disable() {
	draining.Store(false)
}

func IsDraining() bool {
	return draining.Load()
}

func BeginAttach() {
	activeAttach.Add(1)
}

func EndAttach() {
	activeAttach.Add(-1)
}

func ActiveAttachCount() int64 {
	return activeAttach.Load()
}
