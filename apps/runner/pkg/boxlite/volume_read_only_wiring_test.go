// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// TestCreateBindsReadOnlyVolumesReadOnly guards the one hop a behavioral test
// cannot see: boxlite.BoxOption closes over an unexported config, so a fake
// runtime receives opaque functions and cannot tell WithBindMount from
// WithBindMountReadOnly. If Client.Create ever stops choosing
// WithBindMountReadOnly for a read-only mount, every managed volume silently
// binds read-write again — the exact failure the read_only flag exists to
// prevent. Same AST technique as TestCreateAppliesSecrets.
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
