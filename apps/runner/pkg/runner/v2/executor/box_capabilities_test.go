// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package executor

import (
	"context"
	"reflect"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
)

type capabilityCaptureBackend struct {
	backend.BoxBackend
	createRequest  *dto.CreateBoxDTO
	recoverRequest *dto.RecoverBoxDTO
}

func (b *capabilityCaptureBackend) Create(_ context.Context, request dto.CreateBoxDTO) (string, string, error) {
	b.createRequest = &request
	return "box-1", "boxlite", nil
}

func (b *capabilityCaptureBackend) RecoverBox(_ context.Context, _ string, request dto.RecoverBoxDTO) error {
	b.recoverRequest = &request
	return nil
}

// A job payload travels through the queue as opaque JSON, so this covers the
// hop where a dropped policy would silently restore default privileges.
func TestExecuteJobPreservesCapabilityPolicy(t *testing.T) {
	tests := []struct {
		name       string
		jobType    apiclient.JobType
		payload    string
		capability func(*testing.T, *capabilityCaptureBackend) *dto.AdvancedBoxOptionsDTO
	}{
		{
			name:    "create",
			jobType: apiclient.JOBTYPE_CREATE_BOX,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":["NET_RAW"]}}}`,
			capability: func(t *testing.T, capture *capabilityCaptureBackend) *dto.AdvancedBoxOptionsDTO {
				t.Helper()
				if capture.createRequest == nil {
					t.Fatal("create backend was not called")
				}
				return capture.createRequest.Advanced
			},
		},
		{
			name:    "recover",
			jobType: apiclient.JOBTYPE_RECOVER_BOX,
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":["NET_RAW"]}}}`,
			capability: func(t *testing.T, capture *capabilityCaptureBackend) *dto.AdvancedBoxOptionsDTO {
				t.Helper()
				if capture.recoverRequest == nil {
					t.Fatal("recover backend was not called")
				}
				return capture.recoverRequest.Advanced
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			capture := &capabilityCaptureBackend{}
			executor := &Executor{backend: capture}
			job := apiclient.NewJob(
				"job-1",
				test.jobType,
				apiclient.JOBSTATUS_PENDING,
				"box",
				"box-1",
				"2026-01-01T00:00:00Z",
			)
			job.Payload = &test.payload

			if _, err := executor.executeJob(context.Background(), job); err != nil {
				t.Fatalf("execute job: %v", err)
			}

			advanced := test.capability(t, capture)
			if advanced == nil || advanced.Capabilities == nil {
				t.Fatal("backend did not receive advanced capabilities")
			}
			if !reflect.DeepEqual(advanced.Capabilities.Add, []string{"SYS_ADMIN"}) {
				t.Fatalf("unexpected advanced.capabilities.add: %v", advanced.Capabilities.Add)
			}
			if !reflect.DeepEqual(advanced.Capabilities.Drop, []string{"NET_RAW"}) {
				t.Fatalf("unexpected advanced.capabilities.drop: %v", advanced.Capabilities.Drop)
			}
		})
	}
}
