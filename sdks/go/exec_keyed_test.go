package boxlite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// A remote runtime cannot provide local guest token retention. The Go/C path
// must refuse keyed startup instead of silently sending an ordinary exec.
func TestKeyedExecutionRefusesRemoteRuntimeWithoutUnkeyedFallback(t *testing.T) {
	var starts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/keyed-box" {
			_, _ = io.WriteString(w, `{"box_id":"keyed-box","status":"running","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":1,"memory_mib":512}`)
			return
		}
		if r.Method == http.MethodPost {
			starts.Add(1)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	box, err := runtime.Get(context.Background(), "keyed-box")
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	execution, err := box.StartExecution(context.Background(), "true", nil, &ExecutionOptions{IdempotencyKey: "request", ExpectedStartedAt: 1234})
	var sdkErr *Error
	if execution != nil || !errors.As(err, &sdkErr) || sdkErr.Code != ErrUnsupported {
		t.Fatalf("keyed remote execution = %v, %v", execution, err)
	}
	if starts.Load() != 0 {
		t.Fatal("keyed request fell back to ordinary HTTP exec")
	}
}
