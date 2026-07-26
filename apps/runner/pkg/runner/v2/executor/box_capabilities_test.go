// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package executor

import (
	"context"
	"reflect"
	"strings"
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

func TestLegacyJobsRejectCapabilityFieldsBeforeBackend(t *testing.T) {
	tests := []struct {
		name    string
		jobType apiclient.JobType
		payload string
	}{
		{
			name:    "create",
			jobType: apiclient.JOBTYPE_CREATE_BOX,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"]}}}`,
		},
		{
			name:    "recover",
			jobType: apiclient.JOBTYPE_RECOVER_BOX,
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"drop":["NET_RAW"]}}}`,
		},
		{
			name:    "create empty advanced field",
			jobType: apiclient.JOBTYPE_CREATE_BOX,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{}}`,
		},
		{
			name:    "recover null advanced field",
			jobType: apiclient.JOBTYPE_RECOVER_BOX,
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":null}`,
		},
		{
			name:    "create empty capabilities field",
			jobType: apiclient.JOBTYPE_CREATE_BOX,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{}}}`,
		},
		{
			name:    "recover null capabilities field",
			jobType: apiclient.JOBTYPE_RECOVER_BOX,
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":null}}`,
		},
		{
			name:    "create alternate-case advanced field",
			jobType: apiclient.JOBTYPE_CREATE_BOX,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","Advanced":{"capabilities":{"add":["SYS_ADMIN"]}}}`,
		},
		{
			name:    "recover old flat policy field",
			jobType: apiclient.JOBTYPE_RECOVER_BOX,
			payload: `{"osUser":"boxlite","errorReason":"retry","CAPDROP":["NET_RAW"]}`,
		},
		{
			name:    "create snake case flat policy field",
			jobType: apiclient.JOBTYPE_CREATE_BOX,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","cap_add":["SYS_ADMIN"]}`,
		},
		{
			name:    "recover snake case flat policy field",
			jobType: apiclient.JOBTYPE_RECOVER_BOX,
			payload: `{"osUser":"boxlite","errorReason":"retry","cap_drop":["NET_RAW"]}`,
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

			_, err := executor.executeJob(context.Background(), job)
			if err == nil || !strings.Contains(err.Error(), "capability") {
				t.Fatalf("expected explicit capability contract error, got %v", err)
			}
			if capture.createRequest != nil || capture.recoverRequest != nil {
				t.Fatal("legacy capability job reached backend")
			}
		})
	}
}

func (b *capabilityCaptureBackend) Create(_ context.Context, request dto.CreateBoxDTO) (string, string, error) {
	b.createRequest = &request
	return "box-1", "boxlite", nil
}

func (b *capabilityCaptureBackend) RecoverBox(_ context.Context, _ string, request dto.RecoverBoxDTO) error {
	b.recoverRequest = &request
	return nil
}

func TestExecuteCapabilityJobsPreservesPolicy(t *testing.T) {
	tests := []struct {
		name       string
		jobType    apiclient.JobType
		payload    string
		capability func(*capabilityCaptureBackend) ([]string, []string)
	}{
		{
			name:    "create",
			jobType: apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","cpuQuota":1,"gpuQuota":0,"memoryQuota":1,"storageQuota":1,"advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":["NET_RAW"]}}}`,
			capability: func(capture *capabilityCaptureBackend) ([]string, []string) {
				if capture.createRequest == nil {
					t.Fatal("create backend was not called")
				}
				if capture.createRequest.Advanced == nil || capture.createRequest.Advanced.Capabilities == nil {
					t.Fatal("create backend did not receive advanced capabilities")
				}
				return capture.createRequest.Advanced.Capabilities.Add, capture.createRequest.Advanced.Capabilities.Drop
			},
		},
		{
			name:    "recover",
			jobType: apiclient.JOBTYPE_RECOVER_BOX_WITH_CAPABILITIES_V2,
			payload: `{"osUser":"boxlite","cpuQuota":1,"gpuQuota":0,"memoryQuota":1,"storageQuota":1,"errorReason":"retry","advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":["NET_RAW"]}}}`,
			capability: func(capture *capabilityCaptureBackend) ([]string, []string) {
				if capture.recoverRequest == nil {
					t.Fatal("recover backend was not called")
				}
				if capture.recoverRequest.Advanced == nil || capture.recoverRequest.Advanced.Capabilities == nil {
					t.Fatal("recover backend did not receive advanced capabilities")
				}
				return capture.recoverRequest.Advanced.Capabilities.Add, capture.recoverRequest.Advanced.Capabilities.Drop
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
				t.Fatalf("execute capability job: %v", err)
			}

			capabilityAdd, capabilityDrop := test.capability(capture)
			if !reflect.DeepEqual(capabilityAdd, []string{"SYS_ADMIN"}) {
				t.Fatalf("unexpected advanced.capabilities.add: %v", capabilityAdd)
			}
			if !reflect.DeepEqual(capabilityDrop, []string{"NET_RAW"}) {
				t.Fatalf("unexpected advanced.capabilities.drop: %v", capabilityDrop)
			}
		})
	}
}

func TestCapabilityJobsValidateRequiredFieldsBeforeBackend(t *testing.T) {
	tests := []struct {
		name    string
		jobType apiclient.JobType
		payload string
	}{
		{
			name:    "create missing id",
			jobType: apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2,
			payload: `{"image":"alpine:latest","osUser":"boxlite","cpuQuota":1,"gpuQuota":0,"memoryQuota":1,"storageQuota":1,"advanced":{"capabilities":{"add":["SYS_ADMIN"]}}}`,
		},
		{
			name:    "create invalid quotas",
			jobType: apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","cpuQuota":0,"gpuQuota":0,"memoryQuota":0,"storageQuota":0,"advanced":{"capabilities":{"add":["SYS_ADMIN"]}}}`,
		},
		{
			name:    "recover missing error reason",
			jobType: apiclient.JOBTYPE_RECOVER_BOX_WITH_CAPABILITIES_V2,
			payload: `{"osUser":"boxlite","cpuQuota":1,"gpuQuota":0,"memoryQuota":1,"storageQuota":1,"advanced":{"capabilities":{"drop":["NET_RAW"]}}}`,
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

			_, err := executor.executeJob(context.Background(), job)
			if err == nil || !strings.Contains(err.Error(), "validate payload") {
				t.Fatalf("expected payload validation error, got %v", err)
			}
			if capture.createRequest != nil || capture.recoverRequest != nil {
				t.Fatal("invalid strict capability job reached backend")
			}
		})
	}
}

func TestCapabilityJobsRejectUnknownNestedFieldsBeforeBackend(t *testing.T) {
	tests := []struct {
		name    string
		jobType apiclient.JobType
		payload string
	}{
		{
			name:    "create top-level",
			jobType: apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"]}},"futureSecurityOption":true}`,
		},
		{
			name:    "create advanced",
			jobType: apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"]},"futureSecurityOption":true}}`,
		},
		{
			name:    "recover capabilities",
			jobType: apiclient.JOBTYPE_RECOVER_BOX_WITH_CAPABILITIES_V2,
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"drop":["NET_RAW"],"futureCapabilityOption":true}}}`,
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

			_, err := executor.executeJob(context.Background(), job)
			if err == nil || !strings.Contains(err.Error(), "unknown field") {
				t.Fatalf("expected recursive unknown-field rejection, got %v", err)
			}
			if capture.createRequest != nil || capture.recoverRequest != nil {
				t.Fatal("invalid strict capability job reached backend")
			}
		})
	}
}

func TestCapabilityJobsRejectNullNestedFieldsBeforeBackend(t *testing.T) {
	tests := []struct {
		name    string
		jobType apiclient.JobType
		payload string
	}{
		{
			name:    "create null advanced",
			jobType: apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":null}`,
		},
		{
			name:    "recover null capabilities",
			jobType: apiclient.JOBTYPE_RECOVER_BOX_WITH_CAPABILITIES_V2,
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":null}}`,
		},
		{
			name:    "create null add",
			jobType: apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2,
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":null,"drop":["NET_RAW"]}}}`,
		},
		{
			name:    "recover null drop",
			jobType: apiclient.JOBTYPE_RECOVER_BOX_WITH_CAPABILITIES_V2,
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":null}}}`,
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

			if _, err := executor.executeJob(context.Background(), job); err == nil {
				t.Fatal("expected null-field rejection")
			}
			if capture.createRequest != nil || capture.recoverRequest != nil {
				t.Fatal("null-bearing strict capability job reached backend")
			}
		})
	}
}
