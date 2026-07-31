// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// TestCreateHasNoFallibleStepAfterStart guards the coupling documented at the
// bx.Start call in Create.
//
// A successful bx.Start makes BoxLite publish the box's StartedAt, which
// BoxSync reads as evidence that this whole job body succeeded. That only holds
// while Start is the last step of Create that can fail. Nothing about the
// current code enforces it — replacing the hardcoded daemon version with a real
// probe, for instance, would silently break it — so this asserts the shape of
// the source directly.
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

	violations, err := fallibleReturnsAfterStart(fileSet, create)
	if err != nil {
		t.Fatalf("%v", err)
	}
	for _, violation := range violations {
		t.Errorf(
			"Client.Create returns a non-nil error at %s, after bx.Start already "+
				"published StartedAt. Move the fallible step above bx.Start, or "+
				"revisit what that timestamp means.",
			violation,
		)
	}
}

// TestFallibleReturnsAfterStart exercises the guard itself. Its first version
// keyed off the index of the *top-level statement* containing bx.Start, so a
// fallible step added beside the call — inside the same `if !skipStart` block,
// which is where Create actually puts it — fell outside the scanned range and
// went unreported.
func TestFallibleReturnsAfterStart(t *testing.T) {
	const shapeCreateUses = `package boxlite

func (c *Client) Create(ctx context.Context, boxDto dto.CreateBoxDTO) (string, string, error) {
	bx, err := c.runtime.GetOrCreate(ctx, opts, boxDto.Id)
	if err != nil {
		return "", "", err
	}

	skipStart := boxDto.SkipStart != nil && *boxDto.SkipStart
	if !skipStart {
		if err := bx.Start(ctx); START_CONDITION {
// START_GUARD_BODY
			return bx.ID(), "", fmt.Errorf("failed to start box: %w", err)
		}
// POST_START
	}

	return bx.ID(), "boxlite", nil
}
`

	tests := []struct {
		name           string
		startCondition string
		startGuardBody string
		postStart      string
		wantViolations int
		wantShapeError bool
	}{
		{
			name:           "nothing after the start",
			wantViolations: 0,
		},
		{
			name: "fallible step in the same block as the start",
			postStart: `		if err := c.registerBox(ctx, bx); err != nil {
			return bx.ID(), "", err
		}`,
			wantViolations: 1,
		},
		{
			name: "fallible step nested deeper in that block",
			postStart: `		for _, mount := range boxDto.Volumes {
			if err := c.mount(ctx, bx, mount); err != nil {
				return bx.ID(), "", err
			}
		}`,
			wantViolations: 1,
		},
		{
			name: "step whose failure is swallowed",
			postStart: `		if err := c.warmCache(ctx, bx); err != nil {
			c.logger.WarnContext(ctx, "warm cache failed", "error", err)
		}`,
			wantViolations: 0,
		},
		{
			name:           "inverted start guard",
			startCondition: "err == nil",
			startGuardBody: `			if err := c.registerBox(ctx, bx); err != nil {
				return bx.ID(), "", err
			}`,
			wantShapeError: true,
		},
		{
			name:           "start guard checks a different error",
			startCondition: "startErr != nil",
			wantShapeError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			startCondition := tt.startCondition
			if startCondition == "" {
				startCondition = "err != nil"
			}
			source := strings.Replace(shapeCreateUses, "START_CONDITION", startCondition, 1)
			source = strings.Replace(source, "// START_GUARD_BODY", tt.startGuardBody, 1)
			source = strings.Replace(source, "// POST_START", tt.postStart, 1)
			fileSet := token.NewFileSet()
			parsed, err := parser.ParseFile(fileSet, "synthetic.go", source, 0)
			if err != nil {
				t.Fatalf("parse synthetic source: %v", err)
			}

			create := findMethod(parsed, "Client", "Create")
			if create == nil {
				t.Fatal("synthetic source lost Client.Create")
			}

			violations, err := fallibleReturnsAfterStart(fileSet, create)
			if tt.wantShapeError {
				if err == nil {
					t.Fatal("expected malformed start-guard error, got nil")
				}
				if !strings.Contains(err.Error(), "no longer of the form") {
					t.Fatalf("got error %q, want malformed start-guard error", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("%v", err)
			}
			if len(violations) != tt.wantViolations {
				t.Fatalf("got %d violations %v, want %d", len(violations), violations, tt.wantViolations)
			}
		})
	}
}

// fallibleReturnsAfterStart reports every return in fn that can carry a non-nil
// error once bx.Start has already succeeded, as printable positions.
//
// Scoping is by source position rather than by statement index: the call sits
// inside a block, so "after it" has to mean after the call itself, at any depth,
// not after the top-level statement that encloses it.
//
// The start's own error handler is the one exemption — it runs precisely when
// the call did *not* succeed, so nothing was published. Recognising it requires
// the `if err := bx.Start(ctx); err != nil` shape; anything else is reported as
// an error rather than guessed at, because a guard that silently stops covering
// the invariant is worse than no guard.
func fallibleReturnsAfterStart(fileSet *token.FileSet, fn *ast.FuncDecl) ([]string, error) {
	var startCall *ast.CallExpr
	var startGuard *ast.IfStmt
	malformedStartGuard := false
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		if startCall != nil || malformedStartGuard {
			return false
		}
		ifStatement, ok := node.(*ast.IfStmt)
		if !ok || ifStatement.Init == nil {
			return true
		}
		if findCall(ifStatement.Init, "bx", "Start") == nil {
			return true
		}
		startCall = startCallFromErrorGuard(ifStatement)
		if startCall == nil {
			malformedStartGuard = true
			return false
		}
		startGuard = ifStatement
		return false
	})

	if startCall == nil {
		if findCall(fn.Body, "bx", "Start") == nil {
			return nil, fmt.Errorf(
				"no bx.Start call in %s; update this guard if the start step moved",
				fn.Name.Name,
			)
		}
		return nil, fmt.Errorf(
			"bx.Start in %s is no longer of the form `if err := bx.Start(ctx); err != nil`; "+
				"this guard cannot tell its own error handler from a later fallible step — "+
				"update it to match the new shape",
			fn.Name.Name,
		)
	}

	var violations []string
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		returnStatement, ok := node.(*ast.ReturnStmt)
		if !ok || len(returnStatement.Results) == 0 || returnStatement.Pos() < startCall.End() {
			return true
		}
		if returnStatement.Pos() >= startGuard.Body.Pos() && returnStatement.End() <= startGuard.Body.End() {
			return true
		}
		last := returnStatement.Results[len(returnStatement.Results)-1]
		if identifier, ok := last.(*ast.Ident); ok && identifier.Name == "nil" {
			return true
		}
		violations = append(violations, fileSet.Position(returnStatement.Pos()).String())
		return true
	})

	return violations, nil
}

func startCallFromErrorGuard(ifStatement *ast.IfStmt) *ast.CallExpr {
	assignment, ok := ifStatement.Init.(*ast.AssignStmt)
	if !ok || assignment.Tok != token.DEFINE || len(assignment.Lhs) != 1 || len(assignment.Rhs) != 1 {
		return nil
	}

	errorIdentifier, ok := assignment.Lhs[0].(*ast.Ident)
	if !ok {
		return nil
	}
	startCall, ok := assignment.Rhs[0].(*ast.CallExpr)
	if !ok || !isCall(startCall, "bx", "Start") {
		return nil
	}

	condition, ok := ifStatement.Cond.(*ast.BinaryExpr)
	if !ok || condition.Op != token.NEQ {
		return nil
	}
	conditionError, ok := condition.X.(*ast.Ident)
	if !ok || conditionError.Name != errorIdentifier.Name {
		return nil
	}
	conditionNil, ok := condition.Y.(*ast.Ident)
	if !ok || conditionNil.Name != "nil" {
		return nil
	}

	return startCall
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

func findCall(node ast.Node, receiver string, method string) *ast.CallExpr {
	var found *ast.CallExpr
	ast.Inspect(node, func(candidate ast.Node) bool {
		if found != nil {
			return false
		}
		call, ok := candidate.(*ast.CallExpr)
		if !ok {
			return true
		}
		if isCall(call, receiver, method) {
			found = call
			return false
		}
		return true
	})
	return found
}

func isCall(call *ast.CallExpr, receiver string, method string) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != method {
		return false
	}
	identifier, ok := selector.X.(*ast.Ident)
	return ok && identifier.Name == receiver
}
