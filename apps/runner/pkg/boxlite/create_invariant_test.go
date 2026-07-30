// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// TestCreateHasNoFallibleStepAfterStart guards the coupling documented at the
// bx.Start call in Create.
//
// A successful bx.Start makes BoxLite write the box's start record, which
// BoxSync then reads as evidence that this whole job body succeeded. That only
// holds while Start is the last step of Create that can fail. Nothing about
// the current code enforces it — replacing the hardcoded daemon version with a
// real probe, for instance, would silently break it — so this asserts the
// shape of the source directly.
//
// The check is deliberately blunt: after the statement containing bx.Start,
// every return in Create must end in a literal nil error.
func TestCreateHasNoFallibleStepAfterStart(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "client.go", nil, 0)
	if err != nil {
		t.Fatalf("parse client.go: %v", err)
	}

	create := findMethod(parsed, "Client", "Create")
	if create == nil {
		t.Fatal("Client.Create not found in client.go; update this guard if it was renamed")
	}

	startIndex := -1
	for index, statement := range create.Body.List {
		if containsCall(statement, "bx", "Start") {
			startIndex = index
			break
		}
	}
	if startIndex < 0 {
		t.Fatal("no bx.Start call in Client.Create; update this guard if the start step moved")
	}

	for _, statement := range create.Body.List[startIndex+1:] {
		ast.Inspect(statement, func(node ast.Node) bool {
			returnStatement, ok := node.(*ast.ReturnStmt)
			if !ok || len(returnStatement.Results) == 0 {
				return true
			}
			last := returnStatement.Results[len(returnStatement.Results)-1]
			identifier, ok := last.(*ast.Ident)
			if !ok || identifier.Name != "nil" {
				t.Errorf(
					"Client.Create returns a non-nil error at %s, after bx.Start already "+
						"caused the start record to be written. Move the fallible step above "+
						"bx.Start, or revisit the record's meaning.",
					fileSet.Position(returnStatement.Pos()),
				)
			}
			return true
		})
	}
}

func findMethod(file *ast.File, receiverType string, name string) *ast.FuncDecl {
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Name.Name != name || function.Recv == nil || function.Body == nil {
			continue
		}
		if len(function.Recv.List) != 1 {
			continue
		}
		star, ok := function.Recv.List[0].Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		if identifier, ok := star.X.(*ast.Ident); ok && identifier.Name == receiverType {
			return function
		}
	}
	return nil
}

func containsCall(node ast.Node, receiver string, method string) bool {
	found := false
	ast.Inspect(node, func(candidate ast.Node) bool {
		call, ok := candidate.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != method {
			return true
		}
		if identifier, ok := selector.X.(*ast.Ident); ok && identifier.Name == receiver {
			found = true
			return false
		}
		return true
	})
	return found
}
