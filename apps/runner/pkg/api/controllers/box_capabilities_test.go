// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package controllers

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func capabilityRequestContext(t *testing.T, path string, payload string) *gin.Context {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest("POST", path, strings.NewReader(payload))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Params = gin.Params{{Key: "boxId", Value: "box-1"}}
	return ctx
}

func TestLegacyHTTPContractsRejectCapabilityFields(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		payload string
		handler gin.HandlerFunc
	}{
		{
			name:    "create",
			path:    "/boxes",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"]}}}`,
			handler: Create,
		},
		{
			name:    "recover",
			path:    "/boxes/box-1/recover",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"drop":["NET_RAW"]}}}`,
			handler: Recover,
		},
		{
			name:    "create empty advanced field",
			path:    "/boxes",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{}}`,
			handler: Create,
		},
		{
			name:    "recover null advanced field",
			path:    "/boxes/box-1/recover",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":null}`,
			handler: Recover,
		},
		{
			name:    "create empty capabilities field",
			path:    "/boxes",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{}}}`,
			handler: Create,
		},
		{
			name:    "recover null capabilities field",
			path:    "/boxes/box-1/recover",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":null}}`,
			handler: Recover,
		},
		{
			name:    "create old flat policy field",
			path:    "/boxes",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","capAdd":["SYS_ADMIN"]}`,
			handler: Create,
		},
		{
			name:    "create snake case flat policy field",
			path:    "/boxes",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","cap_add":["SYS_ADMIN"]}`,
			handler: Create,
		},
		{
			name:    "recover snake case flat policy field",
			path:    "/boxes/box-1/recover",
			payload: `{"osUser":"boxlite","errorReason":"retry","cap_drop":["NET_RAW"]}`,
			handler: Recover,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := capabilityRequestContext(t, test.path, test.payload)
			test.handler(ctx)

			if len(ctx.Errors) == 0 || !strings.Contains(ctx.Errors.Last().Error(), "capability") {
				t.Fatalf("expected explicit capability contract error, got %v", ctx.Errors)
			}
		})
	}
}

func TestStrictHTTPContractsAcceptOneSidedCapabilityPolicies(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		payload string
		handler gin.HandlerFunc
	}{
		{
			name:    "create add only",
			path:    "/boxes/strict",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"]}}}`,
			handler: CreateWithCapabilities,
		},
		{
			name:    "create drop only",
			path:    "/boxes/strict",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"drop":["NET_RAW"]}}}`,
			handler: CreateWithCapabilities,
		},
		{
			name:    "recover add only",
			path:    "/boxes/box-1/recover/strict",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"add":["SYS_ADMIN"]}}}`,
			handler: RecoverWithCapabilities,
		},
		{
			name:    "recover drop only",
			path:    "/boxes/box-1/recover/strict",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"drop":["NET_RAW"]}}}`,
			handler: RecoverWithCapabilities,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := capabilityRequestContext(t, test.path, test.payload)
			test.handler(ctx)

			if len(ctx.Errors) > 0 && strings.Contains(ctx.Errors.Last().Error(), "invalid request body") {
				t.Fatalf("one-sided capability policy was rejected: %v", ctx.Errors.Last())
			}
		})
	}
}

func TestStrictHTTPContractsRejectUnknownFields(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		payload string
		handler gin.HandlerFunc
	}{
		{
			name:    "create top-level",
			path:    "/boxes/strict",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"]}},"futureSecurityOption":true}`,
			handler: CreateWithCapabilities,
		},
		{
			name:    "create advanced",
			path:    "/boxes/strict",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":["SYS_ADMIN"]},"futureSecurityOption":true}}`,
			handler: CreateWithCapabilities,
		},
		{
			name:    "recover capabilities",
			path:    "/boxes/box-1/recover/strict",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"drop":["NET_RAW"],"futureCapabilityOption":true}}}`,
			handler: RecoverWithCapabilities,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := capabilityRequestContext(t, test.path, test.payload)
			test.handler(ctx)

			if len(ctx.Errors) == 0 || !strings.Contains(ctx.Errors.Last().Error(), "unknown field") {
				t.Fatalf("expected unknown-field rejection, got %v", ctx.Errors)
			}
		})
	}
}

func TestStrictHTTPContractsRejectNullCapabilityFields(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		payload string
		handler gin.HandlerFunc
		want    string
	}{
		{
			name:    "create null advanced",
			path:    "/boxes/strict",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":null}`,
			handler: CreateWithCapabilities,
			want:    "advanced",
		},
		{
			name:    "recover null capabilities",
			path:    "/boxes/box-1/recover/strict",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":null}}`,
			handler: RecoverWithCapabilities,
			want:    "capabilities",
		},
		{
			name:    "create null add",
			path:    "/boxes/strict",
			payload: `{"id":"box-1","image":"alpine:latest","osUser":"boxlite","advanced":{"capabilities":{"add":null,"drop":["NET_RAW"]}}}`,
			handler: CreateWithCapabilities,
			want:    "add must not be null",
		},
		{
			name:    "recover null drop",
			path:    "/boxes/box-1/recover/strict",
			payload: `{"osUser":"boxlite","errorReason":"retry","advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":null}}}`,
			handler: RecoverWithCapabilities,
			want:    "drop must not be null",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := capabilityRequestContext(t, test.path, test.payload)
			test.handler(ctx)

			if len(ctx.Errors) == 0 || !strings.Contains(ctx.Errors.Last().Error(), test.want) {
				t.Fatalf("expected null-field rejection, got %v", ctx.Errors)
			}
		})
	}
}
