//go:build unix

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCompleteOutboundPolicyREST(t *testing.T) {
	for _, tc := range []struct {
		name      string
		deny      []string
		admission OutboundAdmission
	}{
		{"omitted", nil, OutboundAdmissionLegacy},
		{"empty", []string{}, OutboundAdmissionExtendedIPv4},
		{"nonempty", []string{"example.com"}, OutboundAdmissionExtendedIPv4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const base = "/v1/org/boxes"
			const path = base + "/outbound-box/network/outbound/complete"
			type request struct {
				method, path, auth, etag string
				body                     map[string]any
			}
			captured := make(chan request, 8)
			var refuseAfterAllocation atomic.Bool
			snapshot := CompleteOutboundSnapshot{
				Revision: "r1", Admission: tc.admission,
				Policy: EffectiveOutboundPolicy{Mode: NetworkModeEnabled, AllowNet: []string{}, DenyNet: append([]string{}, tc.deny...)},
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				entry := request{method: req.Method, path: req.URL.Path, auth: req.Header.Get("Authorization"), etag: req.Header.Get("If-Match")}
				if req.Method == "POST" || req.Method == "PUT" {
					if err := json.NewDecoder(req.Body).Decode(&entry.body); err != nil {
						t.Errorf("request body: %v", err)
					}
				}
				captured <- entry
				w.Header().Set("Content-Type", "application/json")
				switch req.Method + " " + req.URL.Path {
				case "GET /v1/config":
					_, _ = w.Write([]byte(`{"capabilities":{"complete_outbound_policy_enabled":true}}`))
				case "POST " + base:
					if refuseAfterAllocation.Load() {
						w.WriteHeader(501)
						_, _ = w.Write([]byte(`{"code":"unsupported","creation_effect":"allocated","box_id":"outbound-box","message":"Runner refused policy"}`))
						return
					}
					w.WriteHeader(http.StatusCreated)
					_, _ = w.Write([]byte(`{"box_id":"outbound-box","status":"running","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":1,"memory_mib":512}`))
				case "GET " + path:
					w.Header().Set("ETag", `"r1"`)
					_ = json.NewEncoder(w).Encode(snapshot)
				case "PUT " + path:
					w.Header().Set("ETag", `"r2"`)
					updated := snapshot
					updated.Revision = "r2"
					_ = json.NewEncoder(w).Encode(updated)
				case "GET " + path + "/status":
					updated := snapshot
					updated.Revision = "r2"
					_ = json.NewEncoder(w).Encode(OutboundPolicyStatus{Persisted: &updated, RuntimePersisted: &updated,
						Observed: &CompleteOutboundObservation{Snapshot: updated, ApplicationState: OutboundConfirmed}, ApplicationState: OutboundUncertain})
				default:
					t.Errorf("unexpected request: %s %s", req.Method, req.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			runtime, err := NewRest(BoxliteRestOptions{URL: server.URL, Credential: NewApiKeyCredential("test-token"), PathPrefix: "org"})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			ctx := context.Background()
			policy := CompleteOutboundPolicy{Mode: NetworkModeEnabled, DenyNet: tc.deny}
			_, err = runtime.CreateWithOutboundPolicy(ctx, "alpine", policy,
				WithNetwork(NetworkSpec{Outbound: OutboundNetworkSpec{Mode: NetworkModeEnabled}}))
			if !IsInvalidArgument(err) || len(captured) != 0 {
				t.Fatalf("explicit legacy outbound input must be refused before dispatch: %v", err)
			}
			inboundOnly := WithNetwork(NetworkSpec{Inbound: InboundNetworkSpec{Mode: NetworkModeEnabled}})
			box, err := runtime.CreateWithOutboundPolicy(ctx, "alpine", policy, inboundOnly)
			if err != nil {
				t.Fatalf("create with independent inbound policy: %v", err)
			}
			defer box.Close()
			network, err := box.Network()
			if err != nil {
				t.Fatal(err)
			}
			defer network.Close()
			result, err := network.ReplaceOutboundPolicy(ctx, policy, "r1")
			if err != nil || result.Acknowledged.Revision != "r2" || result.Status == nil || result.Status.ApplicationState != OutboundUncertain || result.ApplicationVerified {
				t.Fatalf("unexpected result: %+v, %v", result, err)
			}
			if len(captured) != 6 {
				t.Fatalf("expected 6 requests, got %d", len(captured))
			}
			config, create, read := <-captured, <-captured, <-captured
			previous, replace, status := <-captured, <-captured, <-captured
			for _, req := range []request{config, create, read, previous, replace, status} {
				if req.auth != "Bearer test-token" {
					t.Fatalf("unexpected authorization: %+v", req)
				}
			}
			if create.method != "POST" || create.path != base || replace.method != "PUT" || replace.path != path || replace.etag != `"r1"` {
				t.Fatalf("unexpected write requests: %+v %+v", create, replace)
			}
			createdNetwork := create.body["network"].(map[string]any)
			if mode := createdNetwork["inbound"].(map[string]any)["mode"]; mode != "enabled" {
				t.Fatalf("independent inbound mode = %v, want enabled", mode)
			}
			outbound := createdNetwork["outbound"].(map[string]any)
			for _, body := range []map[string]any{outbound, replace.body} {
				value, present := body["deny_net"]
				want, _ := json.Marshal(tc.deny)
				got, _ := json.Marshal(value)
				if present != (tc.deny != nil) || string(want) != string(got) {
					t.Fatalf("deny_net presence=%t value=%s, want %s", present, got, want)
				}
			}
			refuseAfterAllocation.Store(true)
			_, _, err = runtime.GetOrCreateWithOutboundPolicy(ctx, "alpine", policy, inboundOnly)
			var failure *OutboundPolicyError
			if !errors.As(err, &failure) || failure.Effect != "allocated" || failure.Status != 501 || failure.BoxID != "outbound-box" || failure.Code != "unsupported" {
				t.Fatalf("allocated create failure: %+v (%v)", failure, err)
			}
			if len(captured) != 2 || (<-captured).path != "/v1/config" || (<-captured).method != "POST" {
				t.Fatal("allocated failure must follow fresh config and one POST")
			}
		})
	}
}

func TestCompleteOutboundCreateCanceledContextDoesNotDispatch(t *testing.T) {
	for _, method := range []string{"create", "get-or-create"} {
		t.Run(method, func(t *testing.T) {
			requests := make(chan string, 4)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				requests <- req.Method + " " + req.URL.Path
				if req.URL.Path == "/v1/config" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"capabilities":{"complete_outbound_policy_enabled":true}}`))
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}))
			defer server.Close()
			runtime, err := NewRest(BoxliteRestOptions{
				URL: server.URL, Credential: NewApiKeyCredential("test-token"), PathPrefix: "org",
			})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()

			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			policy := CompleteOutboundPolicy{Mode: NetworkModeEnabled}
			if method == "create" {
				_, err = runtime.CreateWithOutboundPolicy(ctx, "alpine", policy)
			} else {
				_, _, err = runtime.GetOrCreateWithOutboundPolicy(ctx, "alpine", policy, WithName("worker"))
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("expected canceled context error, got %v", err)
			}
			select {
			case request := <-requests:
				t.Fatalf("canceled call dispatched %s", request)
			case <-time.After(500 * time.Millisecond):
			}
		})
	}
}

func TestPreparedOutboundCreateValidatesAcrossFFI(t *testing.T) {
	ctx := context.Background()
	runtime, err := NewRuntime(WithHomeDir(t.TempDir()))
	if err != nil {
		var unavailable *Error
		if errors.As(err, &unavailable) && (unavailable.Code == ErrUnsupported || unavailable.Code == ErrUnsupportedEngine) {
			t.Skipf("local runtime unavailable: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close() })

	_, err = runtime.PrepareOutboundCreate(ctx, "cloud-revision", json.RawMessage(`{"mode":"enabled","deny_net":null}`))
	if !IsInvalidArgument(err) {
		t.Fatalf("explicit null deny error = %v, want invalid argument", err)
	}

	const name = "hosted-create"
	prepared := PreparedOutboundCreate{Snapshot: CompleteOutboundSnapshot{
		Revision:  "cloud-revision",
		Admission: OutboundAdmissionExtendedIPv4,
		Policy: EffectiveOutboundPolicy{
			Mode:     NetworkModeEnabled,
			AllowNet: []string{"EXAMPLE.com:443"},
			DenyNet:  []string{},
		},
	}}
	box, created, err := runtime.GetOrCreateWithPreparedOutbound(ctx, "alpine", prepared,
		WithName(name), WithNetwork(NetworkSpec{Mode: NetworkModeEnabled}))
	if box != nil {
		_ = box.Close()
	}
	if box != nil || created || !IsInvalidArgument(err) {
		t.Fatalf("noncanonical prepared create: box=%v created=%t err=%v", box, created, err)
	}
	if _, err := runtime.GetInfo(ctx, name); !IsNotFound(err) {
		t.Fatalf("noncanonical prepared create left a Box: %v", err)
	}

	shimDir := t.TempDir()
	t.Setenv("BOXLITE_RUNTIME_DIR", shimDir)
	shim := `#!/bin/sh
test "$(cat)" = '{"outbound_policy_probe":1}' || exit 1
printf '%s\n' '{"admission":true,"deny":true,"port":true,"capacity":true}'`
	if err := os.WriteFile(filepath.Join(shimDir, "boxlite-shim"), []byte(shim), 0700); err != nil {
		t.Fatal(err)
	}
	prepared, err = runtime.PrepareOutboundCreate(ctx, "cloud-revision", json.RawMessage(`{"mode":"enabled","allow_net":["EXAMPLE.com:443"],"deny_net":[]}`))
	if err != nil || !prepared.DenyPresent || !reflect.DeepEqual(prepared.Snapshot.Policy.AllowNet, []string{"example.com:443"}) {
		t.Fatalf("prepared create: %+v err=%v", prepared, err)
	}
	options := []BoxOption{WithName(name), WithNetwork(NetworkSpec{Mode: NetworkModeEnabled})}
	box, created, err = runtime.GetOrCreateWithPreparedOutbound(ctx, "alpine", prepared, options...)
	if err != nil || !created {
		t.Fatalf("prepared create: created=%t err=%v", created, err)
	}
	t.Cleanup(func() { _ = box.Close() })
	network, err := box.Network()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = network.Close() })
	snapshot, err := network.CompleteOutboundSnapshot(ctx)
	if err != nil || !reflect.DeepEqual(snapshot, prepared.Snapshot) {
		t.Fatalf("installed snapshot = %+v, prepared=%+v err=%v", snapshot, prepared.Snapshot, err)
	}
	status, err := network.CompleteOutboundStatus(ctx)
	if err != nil || status.ApplicationState != OutboundUncertain || status.Observed != nil {
		t.Fatalf("configured Box unexpectedly has live status: %+v err=%v", status, err)
	}
	replayed, created, err := runtime.GetOrCreateWithPreparedOutbound(ctx, "alpine", prepared, options...)
	if err != nil || created || replayed.ID() != box.ID() {
		t.Fatalf("prepared replay: created=%t err=%v", created, err)
	}
	_ = replayed.Close()
	prepared.Snapshot.Revision = "different-revision"
	if rejected, created, err := runtime.GetOrCreateWithPreparedOutbound(ctx, "alpine", prepared, options...); rejected != nil || created || !IsInvalidState(err) {
		t.Fatalf("different revision was not refused: box=%v created=%t err=%v", rejected, created, err)
	}

	const limitedRevision = "deny-incapable-revision"
	emptyDenyPolicy := json.RawMessage(`{"mode":"enabled","allow_net":["example.com:443"],"deny_net":[]}`)
	explicit, err := runtime.PrepareOutboundCreate(ctx, limitedRevision, emptyDenyPolicy)
	if err != nil || !explicit.DenyPresent {
		t.Fatalf("explicit empty deny before capability loss: prepared=%+v err=%v", explicit, err)
	}
	shimWithoutDeny := strings.Replace(shim, `"deny":true`, `"deny":false`, 1)
	if err := os.WriteFile(filepath.Join(shimDir, "boxlite-shim"), []byte(shimWithoutDeny), 0700); err != nil {
		t.Fatal(err)
	}
	omitted, err := runtime.PrepareOutboundCreate(ctx, limitedRevision, json.RawMessage(`{"mode":"enabled","allow_net":["example.com:443"]}`))
	if err != nil || omitted.DenyPresent || !reflect.DeepEqual(omitted.Snapshot, explicit.Snapshot) {
		t.Fatalf("omitted deny on deny-incapable backend: prepared=%+v err=%v", omitted, err)
	}
	_, err = runtime.PrepareOutboundCreate(ctx, limitedRevision, emptyDenyPolicy)
	if !networkErrorCode(err, ErrUnsupported) {
		t.Fatalf("explicit empty deny on deny-incapable backend: err=%v, want unsupported", err)
	}

	// The policy identity is the same in both cases. Execute the same prepared
	// snapshot with each presence value to cover a backend change after prepare.
	const limitedName = "deny-incapable-create"
	limitedOptions := []BoxOption{WithName(limitedName), WithNetwork(NetworkSpec{Mode: NetworkModeEnabled})}
	if rejected, created, err := runtime.GetOrCreateWithPreparedOutbound(ctx, "alpine", explicit, limitedOptions...); rejected != nil || created || !networkErrorCode(err, ErrUnsupported) {
		t.Fatalf("explicit empty deny at create: box=%v created=%t err=%v", rejected, created, err)
	}
	if _, err := runtime.GetInfo(ctx, limitedName); !IsNotFound(err) {
		t.Fatalf("unsupported prepared create left a Box: %v", err)
	}
	allowed, created, err := runtime.GetOrCreateWithPreparedOutbound(ctx, "alpine", omitted, limitedOptions...)
	if err != nil || !created || allowed == nil {
		t.Fatalf("omitted deny at create: box=%v created=%t err=%v", allowed, created, err)
	}
	_ = allowed.Close()
}
