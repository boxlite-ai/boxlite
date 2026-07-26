// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package common

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	boxlitesdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/gin-gonic/gin"
)

func TestHandlePossibleDockerErrorMapsBoxliteInvalidArgument(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/boxes", nil)
	advanced, err := boxlitesdk.NewAdvancedBoxOptions()
	if err != nil {
		t.Fatalf("create advanced options: %v", err)
	}
	defer advanced.Close()
	err = advanced.SetCapabilities(boxlitesdk.ContainerCapabilities{Add: []string{"NET-ADMIN"}})
	if err == nil {
		t.Fatal("malformed capability must be rejected")
	}
	err = fmt.Errorf("configure advanced container capabilities: %w", err)

	response := HandlePossibleDockerError(ctx, err)

	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadRequest)
	}
	if response.Code != "BAD_REQUEST" {
		t.Fatalf("code = %q, want BAD_REQUEST", response.Code)
	}
}
