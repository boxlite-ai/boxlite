//go:build unix

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

const managedCapability = `{"capabilities":{"outbound_proxy_registry_enabled":true}}`

func TestManagedProxyOutcomesCrossABI(t *testing.T) {
	for _, tc := range []struct {
		name       string
		httpStatus int
		body       string
		state      ProxyMutationState
		revision   string
	}{
		{"blocked", 409, `{"code":"outbound_update_blocked"}`, ProxyRejected, ""},
		{"unconfirmed", 409, `{"code":"outbound_application_unconfirmed"}`, ProxyUnknown, ""},
		{"release pending", 200, `{}`, ProxyAcceptedReleaseUnconfirmed, "acknowledged"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var writes atomic.Int32
			network := outboundNetwork(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.Method + " " + r.URL.Path {
				case "GET /v1/config":
					_, _ = io.WriteString(w, managedCapability)
				case "GET /v1/boxes/box1/network/outbound":
					w.Header().Set("ETag", `"starting"`)
					_, _ = io.WriteString(w, `{"mode":"enabled","allow_net":["example.org"],"proxy":"outbound"}`)
				case "PUT /v1/boxes/box1/network/outbound":
					writes.Add(1)
					var body map[string]json.RawMessage
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if string(body["proxy"]) != "null" || string(body["allow_net"]) != `["example.org"]` || r.Header.Get("If-Match") != `"starting"` {
						t.Error("unbind did not preserve policy and revision")
					}
					w.Header().Set("ETag", `"acknowledged"`)
					w.WriteHeader(tc.httpStatus)
					_, _ = io.WriteString(w, tc.body)
				case "GET /v1/boxes/box1/network/outbound/status":
					w.WriteHeader(503)
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(404)
				}
			})
			outcome, err := network.SetManagedProxy(context.Background(), nil)
			if outcome.State != tc.state || outcome.Revision != tc.revision || int(outcome.HTTPStatus) != tc.httpStatus {
				t.Fatalf("wrong ABI outcome: %+v (%v)", outcome, err)
			}
			if tc.httpStatus == 409 {
				var mutationError *ProxyMutationError
				if !errors.As(err, &mutationError) || mutationError.Outcome != outcome {
					t.Fatalf("missing typed mutation outcome: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if writes.Load() != 1 {
				t.Fatal("unbind replayed the write")
			}
		})
	}
}

func TestManagedProxyCreateAdmissionCrossABI(t *testing.T) {
	for _, tc := range []struct {
		body      string
		admission ManagedCreateAdmission
		id        string
	}{
		{`{"code":"outbound_create_rejected"}`, ManagedCreateRejected, ""},
		{`{"code":"outbound_create_admitted","boxId":"existing-box"}`, ManagedCreateAdmitted, "existing-box"},
		{`{"code":"outbound_create_admitted","boxId":"invalid/box"}`, ManagedCreateAdmitted, ""},
		{`{"boxId":"possible-box"}`, ManagedCreateUnknown, "possible-box"},
	} {
		var writes atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/v1/config" {
				_, _ = io.WriteString(w, managedCapability)
				return
			}
			if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes" {
				t.Error("unexpected managed create route")
			}
			writes.Add(1)
			var request struct {
				Network struct{ Outbound map[string]json.RawMessage }
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			if string(request.Network.Outbound["proxy"]) != "null" {
				t.Error("explicit unbound selection was omitted")
			}
			w.WriteHeader(400)
			_, _ = io.WriteString(w, tc.body)
		}))
		runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		box, err := runtime.CreateWithOutboundProxy(context.Background(), "alpine", nil)
		_ = runtime.Close()
		server.Close()
		var outcome *ManagedCreateError
		if box != nil || !errors.As(err, &outcome) || outcome.Admission != tc.admission || outcome.BoxID != tc.id || outcome.HTTPStatus != 400 {
			t.Fatalf("wrong admission evidence: %+v", err)
		}
		if writes.Load() != 1 {
			t.Fatal("create replayed the write")
		}
	}
}
