// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"reflect"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"go.opentelemetry.io/otel/trace"
)

func TestCreateBoxDTOHasSingleBoxIdentity(t *testing.T) {
	if _, ok := reflect.TypeOf(dto.CreateBoxDTO{}).FieldByName("BoxId"); ok {
		t.Fatalf("CreateBoxDTO must not carry a legacy BoxId field")
	}
}

func TestBoxRuntimeEnvIncludesRequiredBoxIdentity(t *testing.T) {
	organizationID := "org-1"
	regionID := "region-1"
	otelEndpoint := "http://otel.local:4318"

	got := boxRuntimeEnv(context.Background(), dto.CreateBoxDTO{
		Id:             "box-1",
		OrganizationId: &organizationID,
		RegionId:       &regionID,
		OtelEndpoint:   &otelEndpoint,
	})

	want := map[string]string{
		"BOXLITE_BOX_ID":          "box-1",
		"BOXLITE_ORGANIZATION_ID": "org-1",
		"BOXLITE_REGION_ID":       "region-1",
		"BOXLITE_OTEL_ENDPOINT":   "http://otel.local:4318",
	}

	if len(got) != len(want) {
		t.Fatalf("expected %d env vars, got %d: %#v", len(want), len(got), got)
	}
	for key, wantValue := range want {
		if gotValue := got[key]; gotValue != wantValue {
			t.Fatalf("%s = %q, want %q", key, gotValue, wantValue)
		}
	}
}

func TestBoxRuntimeEnvOmitsEmptyOptionalValues(t *testing.T) {
	empty := ""

	got := boxRuntimeEnv(context.Background(), dto.CreateBoxDTO{
		Id:             "box-1",
		OrganizationId: &empty,
		RegionId:       &empty,
		OtelEndpoint:   &empty,
	})

	if len(got) != 1 {
		t.Fatalf("expected only required runtime env, got %#v", got)
	}
	if got["BOXLITE_BOX_ID"] != "box-1" {
		t.Fatalf("BOXLITE_BOX_ID = %q, want box-1", got["BOXLITE_BOX_ID"])
	}
}

// With an active (remote) span in context, boxRuntimeEnv must propagate it as a W3C
// BOXLITE_TRACEPARENT env so in-box processes can join the same traceId. The value crosses
// propagation.TraceContext{}.Inject (production code), so this is non-tautological.
func TestBoxRuntimeEnvPropagatesTraceparentWhenSpanActive(t *testing.T) {
	traceID, err := trace.TraceIDFromHex("0af7651916cd43dd8448eb211c80319c")
	if err != nil {
		t.Fatalf("trace id: %v", err)
	}
	spanID, err := trace.SpanIDFromHex("b7ad6b7169203331")
	if err != nil {
		t.Fatalf("span id: %v", err)
	}
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	got := boxRuntimeEnv(ctx, dto.CreateBoxDTO{Id: "box-1"})

	wantTP := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	if got["BOXLITE_TRACEPARENT"] != wantTP {
		t.Fatalf("BOXLITE_TRACEPARENT = %q, want %q", got["BOXLITE_TRACEPARENT"], wantTP)
	}
}

// With no active span, BOXLITE_TRACEPARENT must be absent (behavior identical to before the
// propagation change), so the fix is safe to ship dark.
func TestBoxRuntimeEnvOmitsTraceparentWhenNoSpan(t *testing.T) {
	got := boxRuntimeEnv(context.Background(), dto.CreateBoxDTO{Id: "box-1"})

	if _, ok := got["BOXLITE_TRACEPARENT"]; ok {
		t.Fatalf("BOXLITE_TRACEPARENT must be absent without an active span, got %#v", got)
	}
}
