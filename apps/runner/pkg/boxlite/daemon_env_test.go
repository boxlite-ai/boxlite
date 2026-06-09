// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestDaemonSandboxEnvIncludesRequiredSandboxIdentity(t *testing.T) {
	organizationID := "org-1"
	regionID := "region-1"
	otelEndpoint := "http://otel.local:4318"

	got := daemonSandboxEnv(dto.CreateSandboxDTO{
		Id:             "sandbox-1",
		OrganizationId: &organizationID,
		RegionId:       &regionID,
		OtelEndpoint:   &otelEndpoint,
	})

	want := map[string]string{
		"BOXLITE_SANDBOX_ID":      "sandbox-1",
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

func TestDaemonSandboxEnvOmitsEmptyOptionalValues(t *testing.T) {
	empty := ""

	got := daemonSandboxEnv(dto.CreateSandboxDTO{
		Id:             "sandbox-1",
		OrganizationId: &empty,
		RegionId:       &empty,
		OtelEndpoint:   &empty,
	})

	if len(got) != 1 {
		t.Fatalf("expected only required daemon env, got %#v", got)
	}
	if got["BOXLITE_SANDBOX_ID"] != "sandbox-1" {
		t.Fatalf("BOXLITE_SANDBOX_ID = %q, want sandbox-1", got["BOXLITE_SANDBOX_ID"])
	}
}
