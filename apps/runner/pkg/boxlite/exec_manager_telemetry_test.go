// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type telemetryExecHandle struct {
	done chan struct{}
}

func (h *telemetryExecHandle) Signal(context.Context, int) error         { return nil }
func (h *telemetryExecHandle) Kill(context.Context) error                { return nil }
func (h *telemetryExecHandle) ResizeTTY(context.Context, int, int) error { return nil }
func (h *telemetryExecHandle) Close() error                              { return nil }
func (h *telemetryExecHandle) Wait(context.Context) (int, error) {
	<-h.done
	return 17, nil
}

type telemetryExecutionSource struct {
	handle    *telemetryExecHandle
	startErr  error
	attachErr error
}

func (s *telemetryExecutionSource) start(context.Context, StartOptions, io.Writer, io.Writer) (execHandle, io.Writer, string, error) {
	if s.startErr != nil {
		return nil, nil, "", s.startErr
	}
	return s.handle, io.Discard, "exec-1", nil
}
func (s *telemetryExecutionSource) list(context.Context) ([]sdk.ExecutionInfo, error) {
	return []sdk.ExecutionInfo{{ExecutionID: "exec-1"}}, nil
}
func (s *telemetryExecutionSource) get(context.Context, string) (execHandle, error) {
	return s.handle, nil
}
func (s *telemetryExecutionSource) attach(context.Context, string, io.Writer, io.Writer) (execHandle, io.Writer, error) {
	if s.attachErr != nil {
		return nil, nil, s.attachErr
	}
	return s.handle, io.Discard, nil
}

func spanRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	})
	return recorder
}

func findRecordedSpan(recorder *tracetest.SpanRecorder, name string) sdktrace.ReadOnlySpan {
	for _, span := range recorder.Ended() {
		if span.Name() == name {
			return span
		}
	}
	return nil
}

func requireSpanAttribute(t *testing.T, span sdktrace.ReadOnlySpan, key attribute.Key, value string) {
	t.Helper()
	for _, attr := range span.Attributes() {
		if attr.Key == key && attr.Value.AsString() == value {
			return
		}
	}
	t.Fatalf("span %s attributes = %v, want %s=%q", span.Name(), span.Attributes(), key, value)
}

func TestExecManagerTracesStartAndWaitAtSDKBoundary(t *testing.T) {
	recorder := spanRecorder(t)
	manager := newQuietManager(t)
	handle := &telemetryExecHandle{done: make(chan struct{})}
	source := &telemetryExecutionSource{handle: handle}

	id, err := manager.start(context.Background(), source, "box-1", StartOptions{Command: "sleep"})
	if err != nil || id != "exec-1" {
		t.Fatalf("start = %q, %v", id, err)
	}
	startSpan := findRecordedSpan(recorder, "box.exec.start_execution")
	if startSpan == nil {
		t.Fatal("missing StartExecution span")
	}
	requireSpanAttribute(t, startSpan, "box_id", "box-1")
	requireSpanAttribute(t, startSpan, "execution_id", "exec-1")
	if findRecordedSpan(recorder, "box.exec.wait") != nil {
		t.Fatal("Wait span ended while the process was still running")
	}

	_, _ = manager.execs[id].stdoutBus.Write([]byte("one"))
	_, _ = manager.execs[id].stdoutBus.Write([]byte("two"))
	close(handle.done)
	<-manager.execs[id].Done
	waitSpan := findRecordedSpan(recorder, "box.exec.wait")
	if waitSpan == nil {
		t.Fatal("missing Wait span")
	}
	requireSpanAttribute(t, waitSpan, "box_id", "box-1")
	requireSpanAttribute(t, waitSpan, "execution_id", "exec-1")
	if waitSpan.Parent().SpanID() == startSpan.SpanContext().SpanID() {
		t.Error("Wait is nested under the short StartExecution span instead of its parent")
	}
	if waitSpan.Parent().SpanID() != startSpan.Parent().SpanID() {
		t.Error("StartExecution and Wait do not share the same parent")
	}
	for _, attr := range waitSpan.Attributes() {
		if attr.Key == "exit_code" && attr.Value.AsInt64() == 17 {
			return
		}
	}
	t.Fatalf("Wait span attributes = %v, want exit_code=17", waitSpan.Attributes())
}

func TestExecManagerTracesStartFailure(t *testing.T) {
	recorder := spanRecorder(t)
	manager := newQuietManager(t)
	source := &telemetryExecutionSource{startErr: errors.New("start denied")}

	if _, err := manager.start(context.Background(), source, "box-1", StartOptions{}); err == nil {
		t.Fatal("expected start failure")
	}
	span := findRecordedSpan(recorder, "box.exec.start_execution")
	if span == nil || span.Status().Code != codes.Error {
		t.Fatalf("StartExecution span = %#v, want error status", span)
	}
	if findRecordedSpan(recorder, "box.exec.wait") != nil {
		t.Fatal("failed start must not spawn a Wait span")
	}
}

func TestExecManagerTracesOutputAttachSuccessAndFailure(t *testing.T) {
	for _, test := range []struct {
		name      string
		attachErr error
		wantCode  codes.Code
	}{
		{name: "success", wantCode: codes.Ok},
		{name: "failure", attachErr: errors.New("output already claimed"), wantCode: codes.Error},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := spanRecorder(t)
			manager := newQuietManager(t)
			handle := &telemetryExecHandle{done: make(chan struct{})}
			execution := registerStub(t, manager, "exec-1", &stubExecHandle{})
			execution.ID = "exec-1"
			execution.BoxID = "box-1"
			execution.recovered = true
			source := &telemetryExecutionSource{handle: handle, attachErr: test.attachErr}

			_, err := manager.attach(context.Background(), source, execution)
			if test.attachErr != nil && err == nil {
				t.Fatal("expected attach failure")
			}
			span := findRecordedSpan(recorder, "box.exec.attach_output")
			if span == nil || span.Status().Code != test.wantCode {
				t.Fatalf("attach span = %#v, want status %v", span, test.wantCode)
			}
			requireSpanAttribute(t, span, "box_id", "box-1")
			requireSpanAttribute(t, span, "execution_id", "exec-1")
		})
	}
}

func TestCreateInstrumentsNativePreparationGetOrCreateAndStart(t *testing.T) {
	content, err := os.ReadFile("client.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(content)
	for _, fragment := range []string{
		`"box.create_prepare"`,
		`"box.get_or_create"`,
		`"box.start"`,
		`parentCtx := ctx`,
		`ctx = context.WithoutCancel(parentCtx)`,
		`startSpanCtx, startSpan :=`,
		`bx.Start(startSpanCtx)`,
		`c.runtime.GetOrCreate(ctx, boxDto.Image, opts...)`,
	} {
		if !strings.Contains(source, fragment) {
			t.Errorf("Client.Create is missing native telemetry fragment %s", fragment)
		}
	}
}
