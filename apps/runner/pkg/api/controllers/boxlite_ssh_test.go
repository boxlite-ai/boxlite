package controllers

import (
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSSHInvalidConfigurationIsSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/v1/boxes/:boxId/ssh/configure", BoxliteSshConfigure)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/boxes/alias/ssh/configure", strings.NewReader(`{"host_private_key":"sentinel-private","accounts":"sentinel-secret"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "sentinel") {
		t.Fatal("credentials echoed")
	}
	if !strings.Contains(response.Body.String(), "invalid_argument") {
		t.Fatal("missing error code")
	}
}
