package controllers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMemorySnapshotProductionRefusesAndValidates(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/snapshots", BoxliteCreateSnapshot)
	router.POST("/snapshots/:snapshot/boxes", BoxliteSnapshotOperation)
	router.GET("/snapshots/:snapshot", BoxliteSnapshotOperation)
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"POST", "/snapshots", `{"name":"s","snapshot_type":"memory"}`, 501},
		{"POST", "/snapshots", `{"name":"s","snapshot_type":"filesystem"}`, 501},
		{"POST", "/snapshots", `{"name":"s","snapshot_type":"ram"}`, 400},
		{"POST", "/snapshots", `{"name":"s","snapshot_type":"memory","mock":true}`, 400},
		{"POST", "/snapshots", `{"name":"s"} {}`, 400},
		{"GET", "/snapshots/s", "", 501},
		{"POST", "/snapshots/s/boxes", `{"name":"child"}`, 501},
	} {
		t.Run(test.method+test.path+test.body, func(t *testing.T) {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(test.method, test.path, strings.NewReader(test.body)))
			if response.Code != test.status {
				t.Fatalf("got %d: %s", response.Code, response.Body.String())
			}
			if test.status == http.StatusNotImplemented && !strings.Contains(response.Body.String(), `"code":"unsupported"`) {
				t.Fatal(response.Body.String())
			}
		})
	}
}
