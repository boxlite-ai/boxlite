// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// TestBoxliteExecAnswersStartFailureThroughWriteExecStartError guards the call
// site that routes a failed exec start into writeExecStartError. The class and
// envelope tests cannot see that wiring — drop the call and both stay green
// while a missing binary goes back to a bare 500 — so this asserts the shape of
// the source, like TestCreateHasNoFallibleStepAfterStart in pkg/boxlite.
func TestBoxliteExecAnswersStartFailureThroughWriteExecStartError(t *testing.T) {
	fileSet := token.NewFileSet()
	parsed, err := parser.ParseFile(fileSet, "boxlite_exec.go", nil, 0)
	if err != nil {
		t.Fatalf("parse boxlite_exec.go: %v", err)
	}

	handler := findFuncDecl(parsed, "BoxliteExec")
	if handler == nil {
		t.Fatal("BoxliteExec not found in boxlite_exec.go; update this guard if it was renamed")
	}

	if err := assertExecStartErrorAnswered(fileSet, handler, "execManager", "Start", "writeExecStartError"); err != nil {
		t.Errorf("%v", err)
	}
}

// TestExecStartErrorAnsweredGuard exercises the guard itself against the shape
// production uses and the wiring regressions it exists to catch; a guard that
// silently stops covering the invariant is worse than no guard.
func TestExecStartErrorAnsweredGuard(t *testing.T) {
	const shapeBoxliteExecUses = `package controllers

func BoxliteExec(ctx *gin.Context) {
	execId, err := execManager.Start(ctx.Request.Context(), bx, boxId, startOpts)
	if err != nil {
		START_ERROR_HANDLER
	}

	ctx.JSON(http.StatusCreated, ExecResponse{ExecutionID: execId})
}
`

	tests := []struct {
		name            string
		startErrorBody  string
		wantErrContains string
	}{
		{
			name:           "failure is answered through writeExecStartError",
			startErrorBody: "		writeExecStartError(ctx, err)\n		return",
		},
		{
			name:            "failure is answered with a hard-coded 500",
			startErrorBody:  `		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err})`,
			wantErrContains: "writeExecStartError",
		},
		{
			name:            "failure is not answered at all",
			startErrorBody:  "",
			wantErrContains: "writeExecStartError",
		},
		{
			name:            "failure is forwarded as nil",
			startErrorBody:  "		writeExecStartError(ctx, nil)\n		return",
			wantErrContains: "writeExecStartError(ctx, err)",
		},
		{
			name:            "failure is forwarded as another error",
			startErrorBody:  "		writeExecStartError(ctx, startErr)\n		return",
			wantErrContains: "writeExecStartError(ctx, err)",
		},
		{
			name:            "handler keeps going after answering",
			startErrorBody:  "		writeExecStartError(ctx, err)\n		ctx.Next()",
			wantErrContains: "return",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			source := strings.Replace(shapeBoxliteExecUses, "START_ERROR_HANDLER", tt.startErrorBody, 1)
			fileSet := token.NewFileSet()
			parsed, err := parser.ParseFile(fileSet, "synthetic.go", source, 0)
			if err != nil {
				t.Fatalf("parse synthetic source: %v", err)
			}

			handler := findFuncDecl(parsed, "BoxliteExec")
			if handler == nil {
				t.Fatal("synthetic source lost BoxliteExec")
			}

			err = assertExecStartErrorAnswered(fileSet, handler, "execManager", "Start", "writeExecStartError")
			if tt.wantErrContains == "" {
				if err != nil {
					t.Fatalf("got %v, want the wiring accepted", err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected the guard to report the dropped wiring, got nil")
			}
			if !strings.Contains(err.Error(), tt.wantErrContains) {
				t.Fatalf("got error %q, want it to mention %s", err, tt.wantErrContains)
			}
		})
	}
}

// assertExecStartErrorAnswered reports whether fn hands the failure of a
// receiver.method call to answerFunc. The call must sit in an if-init that
// already guards on `err != nil`, or be followed immediately by that guard;
// any other shape is reported as an error rather than guessed at.
func assertExecStartErrorAnswered(fileSet *token.FileSet, fn *ast.FuncDecl, receiver, method, answerFunc string) error {
	for index, statement := range fn.Body.List {
		if findCall(statement, receiver, method) == nil {
			continue
		}

		guard, err := execStartErrorGuard(fn.Body.List, index, receiver, method)
		if err != nil {
			return fmt.Errorf("%s: %w", fileSet.Position(statement.Pos()), err)
		}
		if err := assertAnsweredWith(guard.Body, answerFunc, "ctx", "err"); err != nil {
			return fmt.Errorf(
				"%s: the guard on %s.%s at %s no longer answers through %s; a caller "+
					"mistake like a missing binary would surface as a bare 500 again: %w",
				fileSet.Position(guard.Pos()), receiver, method,
				fileSet.Position(statement.Pos()), answerFunc, err,
			)
		}
		return nil
	}

	return fmt.Errorf(
		"%s no longer calls %s.%s; update this guard if the exec start moved",
		fn.Name.Name, receiver, method,
	)
}

// execStartErrorGuard returns the `if err != nil` statement that owns the
// failure of statements[index]: the statement itself when the call sits in an
// if-init, otherwise the statement right after it.
func execStartErrorGuard(statements []ast.Stmt, index int, receiver, method string) (*ast.IfStmt, error) {
	if guard, ok := statements[index].(*ast.IfStmt); ok && guard.Init != nil {
		if !isErrNotNil(guard.Cond) {
			return nil, fmt.Errorf("the guard on %s.%s is no longer of the form `if err != nil`", receiver, method)
		}
		return guard, nil
	}

	if index+1 >= len(statements) {
		return nil, fmt.Errorf("%s.%s is the last statement the handler runs, so its failure has nowhere to go", receiver, method)
	}
	guard, ok := statements[index+1].(*ast.IfStmt)
	if !ok || guard.Init != nil || !isErrNotNil(guard.Cond) {
		return nil, fmt.Errorf("the statement after %s.%s is no longer of the form `if err != nil`", receiver, method)
	}
	return guard, nil
}

// assertAnsweredWith requires the guard body to answer with
// answerFunc(ctxArg, errArg) and to stop there. Anything else — nil, another
// error, or running on into the success path — leaves the typed response
// unprotected, which is the regression this guard exists to catch.
func assertAnsweredWith(body *ast.BlockStmt, answerFunc, ctxArg, errArg string) error {
	call := fmt.Sprintf("%s(%s, %s)", answerFunc, ctxArg, errArg)

	for index, statement := range body.List {
		expression, ok := statement.(*ast.ExprStmt)
		if !ok {
			continue
		}
		invocation, ok := expression.X.(*ast.CallExpr)
		if !ok {
			continue
		}
		identifier, ok := invocation.Fun.(*ast.Ident)
		if !ok || identifier.Name != answerFunc {
			continue
		}
		if len(invocation.Args) != 2 ||
			!isIdent(invocation.Args[0], ctxArg) ||
			!isIdent(invocation.Args[1], errArg) {
			return fmt.Errorf("the guard no longer answers with %s", call)
		}
		if index+1 >= len(body.List) {
			return fmt.Errorf("%s is the last statement, so the handler runs on into the success path", call)
		}
		if _, ok := body.List[index+1].(*ast.ReturnStmt); !ok {
			return fmt.Errorf("the statement after %s is no longer a return, so the handler runs on into the success path", call)
		}
		return nil
	}

	return fmt.Errorf("the guard no longer answers through %s", call)
}

func isErrNotNil(condition ast.Expr) bool {
	binary, ok := condition.(*ast.BinaryExpr)
	if !ok || binary.Op != token.NEQ {
		return false
	}
	errIdent, ok := binary.X.(*ast.Ident)
	if !ok || errIdent.Name != "err" {
		return false
	}
	remaining, ok := binary.Y.(*ast.Ident)
	return ok && remaining.Name == "nil"
}

func isIdent(expression ast.Expr, name string) bool {
	identifier, ok := expression.(*ast.Ident)
	return ok && identifier.Name == name
}

func findFuncDecl(file *ast.File, name string) *ast.FuncDecl {
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Recv == nil && function.Body != nil && function.Name.Name == name {
			return function
		}
	}
	return nil
}

// findCall returns the first receiver.method call in node, as in
// execManager.Start.
func findCall(node ast.Node, receiver, method string) *ast.CallExpr {
	var found *ast.CallExpr
	ast.Inspect(node, func(candidate ast.Node) bool {
		if found != nil {
			return false
		}
		call, ok := candidate.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != method {
			return true
		}
		if identifier, ok := selector.X.(*ast.Ident); ok && identifier.Name == receiver {
			found = call
			return false
		}
		return true
	})
	return found
}
