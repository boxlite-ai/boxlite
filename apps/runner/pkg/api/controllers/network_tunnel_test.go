package controllers

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestBoxliteNetworkTunnelRequiresConnect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/v1/boxes/box-1/network/tunnel?port=3000", nil)

	BoxliteNetworkTunnel(slog.Default())(ctx)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
}

func TestBoxliteNetworkTunnelRejectsInvalidPortBeforeRuntimeLookup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "boxId", Value: "box-1"}}
	ctx.Request = httptest.NewRequest(http.MethodConnect, "/v1/boxes/box-1/network/tunnel?port=0", nil)

	BoxliteNetworkTunnel(slog.Default())(ctx)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}
