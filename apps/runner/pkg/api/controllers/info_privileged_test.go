package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/boxlite-ai/runner/internal/metrics"
	"github.com/gin-gonic/gin"
)

func TestRunnerInfoReportsPrivilegedSupport(t *testing.T) {
	response := httptest.NewRecorder()
	request, _ := gin.CreateTestContext(response)
	request.JSON(http.StatusOK, runnerInfoResponse(&metrics.Metrics{}, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["supportsPrivileged"] != true {
		t.Fatalf("supportsPrivileged = %v, want true; response = %s", payload["supportsPrivileged"], response.Body.String())
	}
}
