// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
	"github.com/gin-gonic/gin"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

type fakeDirectCreateExecutor struct {
	job *apiclient.Job
	err error
}

func (f *fakeDirectCreateExecutor) AcceptDirectCreate(_ context.Context, job *apiclient.Job) error {
	f.job = job
	return f.err
}

func directCreateRouter(executor *fakeDirectCreateExecutor) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(common_errors.NewErrorMiddleware(common.HandlePossibleDockerError))
	router.Use(middlewares.AuthMiddleware("runner-key"))
	router.POST("/internal/jobs/:jobId/direct-create", DirectCreate(executor))
	return router
}

func directCreateRequest(t *testing.T, router http.Handler, pathJobID string, body []byte, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/internal/jobs/"+pathJobID+"/direct-create", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func directCreateJobJSON(t *testing.T) []byte {
	t.Helper()
	job := apiclient.NewJob("job-1", apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", "box-1", "2026-11-28T04:00:00Z")
	job.SetPayload(`{"image":"alpine","secretCredential":{"token":"private"}}`)
	job.SetTraceContext(map[string]interface{}{"traceparent": "00-4bf92f3577b34da6c025ce3d2b9d1f-00f067aa0ba902b7-01"})
	body, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestDirectCreateRequiresRunnerAuthentication(t *testing.T) {
	executor := &fakeDirectCreateExecutor{}
	response := directCreateRequest(t, directCreateRouter(executor), "job-1", directCreateJobJSON(t), "Bearer wrong")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if executor.job != nil {
		t.Fatal("unauthenticated request reached the executor")
	}
}

func TestDirectCreateValidatesJobTypeAndPathIdentity(t *testing.T) {
	for _, test := range []struct {
		name string
		body func(t *testing.T) []byte
		path string
	}{
		{"malformed JSON", func(*testing.T) []byte { return []byte(`{"id":`) }, "job-1"},
		{"path mismatch", directCreateJobJSON, "another-job"},
		{"wrong job type", func(t *testing.T) []byte {
			job := apiclient.NewJob("job-1", apiclient.JOBTYPE_START_BOX, apiclient.JOBSTATUS_IN_PROGRESS, "BOX", "box-1", "2026-11-28T04:00:00Z")
			body, err := json.Marshal(job)
			if err != nil {
				t.Fatal(err)
			}
			return body
		}, "job-1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			executor := &fakeDirectCreateExecutor{}
			response := directCreateRequest(t, directCreateRouter(executor), test.path, test.body(t), "Bearer runner-key")
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body = %s", response.Code, response.Body.String())
			}
			if executor.job != nil {
				t.Fatal("invalid job reached the executor")
			}
		})
	}
}

func TestDirectCreateAcceptsCompleteJob(t *testing.T) {
	executor := &fakeDirectCreateExecutor{}
	response := directCreateRequest(t, directCreateRouter(executor), "job-1", directCreateJobJSON(t), "Bearer runner-key")
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body = %s", response.Code, response.Body.String())
	}
	if executor.job == nil || executor.job.GetId() != "job-1" || executor.job.GetType() != apiclient.JOBTYPE_CREATE_BOX {
		t.Fatalf("accepted job = %#v", executor.job)
	}
	if executor.job.GetResourceId() != "box-1" || executor.job.GetTraceContext()["traceparent"] == nil {
		t.Fatalf("accepted job lost resource or trace context: %#v", executor.job)
	}
	if executor.job.GetPayload() == "" {
		t.Fatal("accepted job lost its payload")
	}
}

func TestDirectCreateReportsCapacityWithoutStartingWork(t *testing.T) {
	fakeExecutor := &fakeDirectCreateExecutor{err: executor.ErrDirectCreateCapacity}
	response := directCreateRequest(t, directCreateRouter(fakeExecutor), "job-1", directCreateJobJSON(t), "Bearer runner-key")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body = %s", response.Code, response.Body.String())
	}
	if !errors.Is(fakeExecutor.err, executor.ErrDirectCreateCapacity) {
		t.Fatal("test did not exercise the capacity error")
	}
}
