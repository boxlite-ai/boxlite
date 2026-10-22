//go:build unix

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNetworkPolicyUpdatesCrossFFI(t *testing.T) {
	type request struct {
		path  string
		mode  NetworkMode
		rules []string
	}
	requests := make(chan request, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1" {
			_, _ = io.WriteString(w, `{"box_id":"box1","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}`)
			return
		}
		if r.Method != http.MethodPut {
			http.NotFound(w, r)
			return
		}
		var policy struct {
			Mode     NetworkMode `json:"mode"`
			AllowNet []string    `json:"allow_net"`
		}
		if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
			t.Error(err)
			return
		}
		requests <- request{r.URL.Path, policy.Mode, policy.AllowNet}
		w.Header().Set("Content-Type", "application/json")
		if policy.Mode == NetworkModeDisabled {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"message":"unsupported","type":"UnsupportedError","code":"unsupported"}}`)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	box, err := rt.Get(context.Background(), "box1")
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	network, err := box.Network()
	if err != nil {
		t.Fatal(err)
	}
	defer network.Close()
	if err := network.UpdateInbound(context.Background(), InboundNetworkSpec{Mode: NetworkModeEnabled}); err != nil {
		t.Fatal(err)
	}
	if err := network.UpdateOutbound(context.Background(), OutboundNetworkSpec{Mode: NetworkModeEnabled}); err != nil {
		t.Fatal(err)
	}
	if err := network.UpdateOutbound(context.Background(), OutboundNetworkSpec{Mode: NetworkModeDisabled}); !networkErrorCode(err, ErrUnsupported) {
		t.Fatalf("want unsupported, got %v", err)
	}
	first, second := <-requests, <-requests
	if first.path != "/v1/boxes/box1/network/inbound" || second.path != "/v1/boxes/box1/network/outbound" || second.rules == nil {
		t.Fatalf("wrong wire requests: %+v %+v", first, second)
	}
	if err := network.UpdateOutbound(context.Background(), OutboundNetworkSpec{Mode: NetworkModeDisabled, AllowNet: []string{"example.com"}}); !networkErrorCode(err, ErrInvalidArgument) {
		t.Fatalf("want invalid argument, got %v", err)
	}
}

func networkErrorCode(err error, code ErrorCode) bool {
	var sdkError *Error
	return errors.As(err, &sdkError) && sdkError.Code == code
}
