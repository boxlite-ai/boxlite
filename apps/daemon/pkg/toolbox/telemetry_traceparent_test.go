// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package toolbox

import (
	"context"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// With a propagated W3C traceparent, the daemon's boot span must share the SAME traceId as the
// api->runner spans and carry a remote parent — this is what makes "one traceId finds the box".
// TraceID comes from production code (Extract+Start), so the assertion is non-tautological.
func TestSeedBootSpanFromTraceParentJoinsApiTraceId(t *testing.T) {
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp))
	defer func() { _ = tp.Shutdown(context.Background()) }()

	traceParent := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	seedBootSpanFromTraceParent(context.Background(), tp.Tracer("boxlite.box"), &traceParent)

	spans := exp.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("want exactly 1 boot span, got %d", len(spans))
	}
	if spans[0].Name != "box.boot" {
		t.Fatalf("boot span name = %q, want box.boot", spans[0].Name)
	}
	if got := spans[0].SpanContext.TraceID().String(); got != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("boot span traceID = %s, want api traceID 0af7651916cd43dd8448eb211c80319c", got)
	}
	if !spans[0].Parent.IsRemote() {
		t.Fatalf("boot span parent must be the remote api/runner span context")
	}
}

// No traceparent => no boot span (behavior identical to before the fix; safe to ship dark).
func TestSeedBootSpanFromTraceParentNoopWhenAbsent(t *testing.T) {
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp))
	defer func() { _ = tp.Shutdown(context.Background()) }()

	seedBootSpanFromTraceParent(context.Background(), tp.Tracer("boxlite.box"), nil)
	empty := ""
	seedBootSpanFromTraceParent(context.Background(), tp.Tracer("boxlite.box"), &empty)

	if n := len(exp.GetSpans()); n != 0 {
		t.Fatalf("expected no boot span when traceparent absent, got %d", n)
	}
}
