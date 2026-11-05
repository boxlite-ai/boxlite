package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/boxlite-ai/runner/internal"
	"github.com/gin-gonic/gin"
)

func TestHealthCheckReportsCustomKernelSupport(t *testing.T) {
	response := httptest.NewRecorder()
	request, _ := gin.CreateTestContext(response)
	HealthCheck(request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["status"] != "ok" || payload["version"] != internal.Version {
		t.Fatalf("unexpected health response: %s", response.Body.String())
	}
	if payload["custom_kernel"] != "supported" {
		t.Fatalf("custom_kernel = %q, want supported", payload["custom_kernel"])
	}
}
