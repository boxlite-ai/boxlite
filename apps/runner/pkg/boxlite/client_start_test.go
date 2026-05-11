// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import (
	"context"
	"log/slog"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// fakeBox is a test double for boxStarter that does not require a real VM.
type fakeBox struct {
	startErr error
	info     *boxlite.BoxInfo
	infoErr  error
}

func (f *fakeBox) Start(_ context.Context) error                    { return f.startErr }
func (f *fakeBox) Info(_ context.Context) (*boxlite.BoxInfo, error) { return f.info, f.infoErr }

func invalidStateErr(msg string) error {
	return &boxlite.Error{Code: boxlite.ErrInvalidState, Message: msg}
}

// TestStartIdempotent_AlreadyRunning is the core regression test:
// Create() auto-starts the box; the subsequent explicit Start() call from the
// Python SDK returns ErrInvalidState, and we must treat it as a no-op when
// the box is confirmed Running.
func TestStartIdempotent_AlreadyRunning(t *testing.T) {
	bx := &fakeBox{
		startErr: invalidStateErr("box is not in a startable state"),
		info:     &boxlite.BoxInfo{State: boxlite.StateRunning},
	}
	if err := startIdempotent(context.Background(), bx, "test-id", slog.Default()); err != nil {
		t.Fatalf("expected no error when box is already running, got: %v", err)
	}
}

// TestStartIdempotent_StoppingIsError ensures ErrInvalidState is not silently
// swallowed when the box is in a genuinely non-startable state (e.g. Stopping).
func TestStartIdempotent_StoppingIsError(t *testing.T) {
	bx := &fakeBox{
		startErr: invalidStateErr("box is stopping"),
		info:     &boxlite.BoxInfo{State: boxlite.StateStopping},
	}
	err := startIdempotent(context.Background(), bx, "test-id", slog.Default())
	if err == nil {
		t.Fatal("expected error when box is stopping, got nil")
	}
	if !boxlite.IsInvalidState(err) {
		t.Fatalf("expected ErrInvalidState, got: %v", err)
	}
}

// TestStartIdempotent_InfoFailsIsError ensures that when Info() itself errors
// after receiving ErrInvalidState, the original Start error is propagated.
func TestStartIdempotent_InfoFailsIsError(t *testing.T) {
	bx := &fakeBox{
		startErr: invalidStateErr("box is not in a startable state"),
		infoErr:  &boxlite.Error{Code: boxlite.ErrInternal, Message: "info call failed"},
	}
	if err := startIdempotent(context.Background(), bx, "test-id", slog.Default()); err == nil {
		t.Fatal("expected error when Info() fails, got nil")
	}
}

// TestStartIdempotent_NormalStart covers the happy path where Start() succeeds.
func TestStartIdempotent_NormalStart(t *testing.T) {
	bx := &fakeBox{startErr: nil}
	if err := startIdempotent(context.Background(), bx, "test-id", slog.Default()); err != nil {
		t.Fatalf("expected no error on successful start, got: %v", err)
	}
}
