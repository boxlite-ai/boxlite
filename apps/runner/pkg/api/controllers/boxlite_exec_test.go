package controllers

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-labs/runner/pkg/boxlite"
)

func TestStreamManagedExecOutputIncludesOutputAndExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	managedExec := &boxlite.ManagedExec{
		StdoutR: stdoutR,
		StderrR: stderrR,
		Done:    make(chan struct{}),
	}

	recorder := httptest.NewRecorder()
	streamDone := make(chan struct{})
	go func() {
		streamManagedExecOutput(ctx, recorder, managedExec)
		close(streamDone)
	}()

	if _, err := stdoutW.Write([]byte("hello\n")); err != nil {
		t.Fatalf("write stdout: %v", err)
	}
	if _, err := stderrW.Write([]byte("warn\n")); err != nil {
		t.Fatalf("write stderr: %v", err)
	}
	if err := stdoutW.Close(); err != nil {
		t.Fatalf("close stdout writer: %v", err)
	}
	if err := stderrW.Close(); err != nil {
		t.Fatalf("close stderr writer: %v", err)
	}

	managedExec.ExitCode = 7
	close(managedExec.Done)

	select {
	case <-streamDone:
	case <-ctx.Done():
		t.Fatal("stream did not finish")
	}

	body := recorder.Body.String()
	for _, expected := range []string{
		"event: stdout",
		`data: {"data":"aGVsbG8K"}`,
		"event: stderr",
		`data: {"data":"d2Fybgo="}`,
		"event: exit",
		`"exit_code":7`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q in SSE body:\n%s", expected, body)
		}
	}
}
