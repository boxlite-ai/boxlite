// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// TestCreateAppliesSecrets guards the hop that `secretSpecs` alone cannot: a
// pure mapping function test passes whether or not Client.Create actually feeds
// the resulting Secrets into the SDK. This asserts the source shape directly,
// the same way TestCreateHasNoFallibleStepAfterStart guards the Start coupling.
func TestCreateAppliesSecrets(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "client.go", nil, 0)
	if err != nil {
		t.Fatalf("parse client.go: %v", err)
	}

	create := findMethod(parsed, "Client", "Create")
	if create == nil {
		t.Fatal("Client.Create not found in client.go")
	}

	if findCall(create.Body, "boxlite", "WithSecret") == nil {
		t.Fatal("Client.Create no longer calls boxlite.WithSecret; secrets would be dropped")
	}
}

// TestRecoverForwardsSecrets guards the recover hop: RecoverBox rebuilds a
// CreateBoxDTO by hand, so a field not copied there is silently lost on a
// recovered box.
func TestRecoverForwardsSecrets(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "stubs.go", nil, 0)
	if err != nil {
		t.Fatalf("parse stubs.go: %v", err)
	}

	recoverBox := findMethod(parsed, "Client", "RecoverBox")
	if recoverBox == nil {
		t.Fatal("Client.RecoverBox not found in stubs.go")
	}

	forwardsSecrets := false
	ast.Inspect(recoverBox.Body, func(node ast.Node) bool {
		kv, ok := node.(*ast.KeyValueExpr)
		if !ok {
			return true
		}
		if id, ok := kv.Key.(*ast.Ident); ok && id.Name == "Secrets" {
			forwardsSecrets = true
			return false
		}
		return true
	})

	if !forwardsSecrets {
		t.Fatal("Client.RecoverBox no longer copies recoverDto.Secrets; recovered boxes would drop secrets")
	}
}
