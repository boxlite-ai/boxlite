package toolbox

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

func newAuthTestEngine(t *testing.T, required bool, token string) *gin.Engine {
	t.Helper()
	s := &server{authToken: token}
	r := gin.New()
	r.Use(s.toolboxAuthMiddlewareMode(required))
	r.POST("/init", func(c *gin.Context) { c.Status(http.StatusOK) }) // exempt
	r.POST("/process/execute", func(c *gin.Context) { c.Status(http.StatusOK) })
	return r
}

func do(t *testing.T, r *gin.Engine, method, path, auth string) int {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	return rr.Code
}

// TestToolboxAuth_EnforcesTokenWhenRequired is the security regression: with
// enforcement on, a sensitive route (process execute → RCE) must reject missing
// or wrong tokens, and accept only the exact token. Before the fix the toolbox
// had no auth at all, so any reachable caller got unauthenticated RCE.
func TestToolboxAuth_EnforcesTokenWhenRequired(t *testing.T) {
	r := newAuthTestEngine(t, true, "secret-token")

	if code := do(t, r, http.MethodPost, "/process/execute", ""); code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", code)
	}
	if code := do(t, r, http.MethodPost, "/process/execute", "Bearer wrong"); code != http.StatusUnauthorized {
		t.Errorf("wrong token: status = %d, want 401", code)
	}
	if code := do(t, r, http.MethodPost, "/process/execute", "Bearer secret-token"); code != http.StatusOK {
		t.Errorf("correct token: status = %d, want 200", code)
	}
	// /init must stay reachable without a token (it is what sets the token).
	if code := do(t, r, http.MethodPost, "/init", ""); code != http.StatusOK {
		t.Errorf("/init should be exempt: status = %d, want 200", code)
	}
}

// TestToolboxAuth_EnforcesWhenTokenUnset: enforcement on but token not yet set
// (request before /init) must fail closed.
func TestToolboxAuth_EnforcesWhenTokenUnset(t *testing.T) {
	r := newAuthTestEngine(t, true, "")
	if code := do(t, r, http.MethodPost, "/process/execute", "Bearer anything"); code != http.StatusUnauthorized {
		t.Errorf("unset token: status = %d, want 401 (fail closed)", code)
	}
}

// TestToolboxAuth_DisabledByDefault documents that with enforcement off (the
// default) the existing path is unaffected.
func TestToolboxAuth_DisabledByDefault(t *testing.T) {
	r := newAuthTestEngine(t, false, "secret-token")
	if code := do(t, r, http.MethodPost, "/process/execute", ""); code != http.StatusOK {
		t.Errorf("disabled: status = %d, want 200 (pass-through)", code)
	}
}
