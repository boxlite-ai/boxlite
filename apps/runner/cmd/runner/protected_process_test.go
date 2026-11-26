// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"strings"
	"testing"
)

func TestProtectedProcessStartTicks(t *testing.T) {
	stat := "23 (runner with ) in its name) S " + strings.Repeat("0 ", 18) + "867 0"
	ticks, err := processStartTicks(stat)
	if err != nil || ticks != 867 {
		t.Fatalf("process start ticks = %d, error = %v", ticks, err)
	}
	if _, err := processStartTicks("23 (runner) S 0"); err == nil {
		t.Fatal("truncated /proc stat supplied a process start time")
	}
}
