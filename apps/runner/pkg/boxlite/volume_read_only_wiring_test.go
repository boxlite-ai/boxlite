// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// TestNewVolumeMountCarriesReadOnly guards the hop from the API's wire field
// to the bind: decoding "readOnly" into the DTO and copying it onto the
// volumeMount that Client.Create reads.
func TestNewVolumeMountCarriesReadOnly(t *testing.T) {
	var decoded []dto.VolumeDTO
	wire := `[{"volumeId":"vol-1","mountPath":"/data","readOnly":true},{"volumeId":"vol-2","mountPath":"/scratch"}]`
	if err := json.Unmarshal([]byte(wire), &decoded); err != nil {
		t.Fatalf("decode volumes: %v", err)
	}
	if !decoded[0].ReadOnly || decoded[1].ReadOnly {
		t.Fatalf("decoded ReadOnly = %v, %v; want true, false", decoded[0].ReadOnly, decoded[1].ReadOnly)
	}

	for _, vol := range decoded {
		mount := newVolumeMount(vol, "/mnt/host", "/mnt/root")
		if mount.readOnly != vol.ReadOnly {
			t.Errorf("volume %s: readOnly = %v, want %v", vol.VolumeId, mount.readOnly, vol.ReadOnly)
		}
		if mount.hostPath != "/mnt/host" || mount.mountPath != vol.MountPath || mount.rootPath != "/mnt/root" {
			t.Errorf("volume %s: mount = %+v", vol.VolumeId, mount)
		}
	}
}

// TestCreateBindsReadOnlyVolumesReadOnly guards that Client.Create picks
// WithBindMountReadOnly on the mount's readOnly flag. A behavioral test cannot
// see that choice: boxlite.BoxOption closes over an unexported config, so a
// fake runtime receives opaque functions and cannot tell WithBindMount from
// WithBindMountReadOnly. Same AST technique as TestCreateAppliesSecrets.
func TestCreateBindsReadOnlyVolumesReadOnly(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "client.go", nil, 0)
	if err != nil {
		t.Fatalf("parse client.go: %v", err)
	}

	create := findMethod(parsed, "Client", "Create")
	if create == nil {
		t.Fatal("Client.Create not found in client.go")
	}

	if findCall(create.Body, "boxlite", "WithBindMountReadOnly") == nil {
		t.Fatal("Client.Create no longer calls boxlite.WithBindMountReadOnly; read-only mounts would bind read-write")
	}

	// The read-only option must be selected by the mount's readOnly flag, not
	// unconditionally: an `if <...>.readOnly { WithBindMountReadOnly(...) }`
	// branch somewhere in Create.
	guarded := false
	ast.Inspect(create.Body, func(node ast.Node) bool {
		ifStmt, ok := node.(*ast.IfStmt)
		if !ok {
			return true
		}
		selector, ok := ifStmt.Cond.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "readOnly" {
			return true
		}
		if findCall(ifStmt.Body, "boxlite", "WithBindMountReadOnly") != nil {
			guarded = true
		}
		return true
	})
	if !guarded {
		t.Fatal("Client.Create does not select boxlite.WithBindMountReadOnly under an `if <mount>.readOnly` branch")
	}
}
