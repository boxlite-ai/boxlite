package controllers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestNetworkPolicyRejectsInvalidBodiesBeforeRunnerLookup(t *testing.T) {
	router := gin.New()
	router.PUT("/boxes/:boxId/network/outbound", BoxliteSetOutboundNetwork)
	for _, body := range []string{
		`{}`, `{"mode":"off"}`, `{"mode":"enabled","unknown":1}`,
		`{"mode":"disabled","allow_net":["example.com"]}`, `{"mode":"enabled"}{}`,
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPut, "/boxes/box1/network/outbound", strings.NewReader(body))
		router.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_argument"`) {
			t.Fatalf("body %s: %d %s", body, w.Code, w.Body)
		}
	}
}
