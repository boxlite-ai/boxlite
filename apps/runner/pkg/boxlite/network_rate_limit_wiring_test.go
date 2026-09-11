// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"go/parser"
	"go/token"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// TestCreateAppliesNetworkRateLimit guards the hop a mapping test cannot see —
// boxlite.BoxOption closes over an unexported config, so a fake runtime only
// receives opaque functions. Client.Create must hand the cap to the SDK through
// an advanced-options handle, or a capped request yields an unshaped box that
// still reports success.
func TestCreateAppliesNetworkRateLimit(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "client.go", nil, 0)
	if err != nil {
		t.Fatalf("parse client.go: %v", err)
	}

	create := findMethod(parsed, "Client", "Create")
	if create == nil {
		t.Fatal("Client.Create not found in client.go")
	}

	if findCall(create.Body, "advanced", "SetNetworkRateLimit") == nil {
		t.Fatal("Client.Create no longer calls advanced.SetNetworkRateLimit; a cap would be dropped")
	}
	if findCall(create.Body, "boxlite", "WithAdvancedOptions") == nil {
		t.Fatal("Client.Create no longer attaches the advanced options; a cap would be dropped")
	}
}

// TestRecoverForwardsNetworkRateLimit: recoverCreateDto is the hand-built
// request RecoverBox replays, and a field not copied there is silently lost
// on every recovered box.
func TestRecoverForwardsNetworkRateLimit(t *testing.T) {
	recoverDto := dto.RecoverBoxDTO{
		OsUser:        "root",
		CpuQuota:      1,
		MemoryQuota:   1,
		StorageQuota:  1,
		NetworkTxKbps: 10_000,
		NetworkRxKbps: 100_000,
	}

	createDto := recoverCreateDto("box-1", recoverDto)

	if createDto.NetworkTxKbps != 10_000 || createDto.NetworkRxKbps != 100_000 {
		t.Fatalf(
			"recoverCreateDto dropped the network rate limit: tx=%d rx=%d",
			createDto.NetworkTxKbps, createDto.NetworkRxKbps,
		)
	}
}
