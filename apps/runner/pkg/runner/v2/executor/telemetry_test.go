// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"encoding/json"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestGetJobTelemetryContextReadsTrustedJobPayload(t *testing.T) {
	payload, err := json.Marshal(map[string]string{
		"organizationId": "org-a",
		"runnerId":       "runner-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	payloadString := string(payload)
	job := &apiclient.Job{Payload: &payloadString}

	telemetry := (&Executor{}).getJobTelemetryContext(job)

	if telemetry.OrganizationID != "org-a" {
		t.Fatalf("organization id = %q, want org-a", telemetry.OrganizationID)
	}
	if telemetry.RunnerID != "runner-a" {
		t.Fatalf("runner id = %q, want runner-a", telemetry.RunnerID)
	}
}
