// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// TestPulledImageIsReadAfterTheBoxStarts guards the one hop neither side's
// tests can see.
//
// GetOrCreate allocates a handle and persists the box; the image is not pulled
// until the first start ("The VM is not started until start() or exec() is
// called", rt_impl.rs). So a read placed beside GetOrCreate compiles, finds no
// resolved image every time, and leaves the control plane never learning a digest —
// with every unit test on both sides still passing, because the runner's sync
// tests stub the report and the API's tests call the registrar directly.
//
// Asserted on the source because a behavioural test cannot reach it: pulling
// an image needs a registry and a VM.
func TestPulledImageIsReadAfterTheBoxStarts(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "client.go", nil, 0)
	if err != nil {
		t.Fatalf("parse client.go: %v", err)
	}

	for _, method := range []string{"Create", "Start"} {
		fn := findMethod(parsed, "Client", method)
		if fn == nil {
			t.Fatalf("Client.%s not found in client.go; update this guard if it was renamed", method)
		}

		startPos := positionOfCall(fn, "bx", "Start")
		if startPos == token.NoPos {
			t.Fatalf("Client.%s no longer starts the box; this guard assumes it does", method)
		}
		recordPos := positionOfSelfCall(fn, "recordPulledImage")
		if recordPos == token.NoPos {
			t.Fatalf(
				"Client.%s no longer records what the image resolved to; the control plane "+
					"would never learn a digest and every create would re-resolve the tag",
				method,
			)
		}
		if recordPos < startPos {
			t.Errorf(
				"Client.%s reads the pulled image at %s, before bx.Start at %s. Nothing is "+
					"pulled until the box starts, so that read always comes back empty.",
				method,
				fileSet.Position(recordPos),
				fileSet.Position(startPos),
			)
		}
	}
}

// positionOfCall reports where fn calls receiver.method, or NoPos.
func positionOfCall(fn *ast.FuncDecl, receiver, method string) token.Pos {
	found := token.NoPos
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		if found != token.NoPos {
			return false
		}
		if call := asSelectorCall(node, receiver, method); call != nil {
			found = call.Pos()
			return false
		}
		return true
	})
	return found
}

// positionOfSelfCall reports where fn calls c.method, or NoPos.
func positionOfSelfCall(fn *ast.FuncDecl, method string) token.Pos {
	return positionOfCall(fn, "c", method)
}

func asSelectorCall(node ast.Node, receiver, method string) *ast.CallExpr {
	call, ok := node.(*ast.CallExpr)
	if !ok {
		return nil
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != method {
		return nil
	}
	ident, ok := selector.X.(*ast.Ident)
	if !ok || ident.Name != receiver {
		return nil
	}
	return call
}
