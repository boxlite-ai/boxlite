package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func completeTestSnapshot(revision, admission string) completeOutboundSnapshot {
	return completeOutboundSnapshot{
		Revision: revision, Admission: admission,
		Policy: completeOutboundPolicy{Mode: "enabled", AllowNet: []string{}, DenyNet: []string{}},
	}
}

func completeTestRequest(t *testing.T, snapshot completeOutboundSnapshot, expected string, deny json.RawMessage) *http.Request {
	t.Helper()
	body, err := json.Marshal(struct {
		Replace struct {
			Snapshot completeOutboundSnapshot `json:"snapshot"`
			Deny     json.RawMessage          `json:"deny_net,omitempty"`
		} `json:"outbound_v1"`
	}{Replace: struct {
		Snapshot completeOutboundSnapshot `json:"snapshot"`
		Deny     json.RawMessage          `json:"deny_net,omitempty"`
	}{snapshot, deny}})
	if err != nil {
		t.Fatal(err)
	}
	return outboundUpdate(string(body), outboundETag(expected), snapshot.Revision)
}

func TestCompleteOutboundRequiresDenyForExplicitEmptyWithinLegacy(t *testing.T) {
	tap := startNetwork(t, nil)
	before := tap.policy.active.Load()
	candidate := completeTestSnapshot("clear", legacyAdmission)
	tap.policy.capabilities.Deny = false
	response := outboundControl(tap, completeTestRequest(t, candidate, before.revision, json.RawMessage("[]")))
	if response.Code != http.StatusNotImplemented || tap.policy.active.Load() != before {
		t.Fatalf("refusal changed the snapshot: %d %s", response.Code, response.Body)
	}
	response = outboundControl(tap, completeTestRequest(t, candidate, before.revision, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("omitted deny was refused: %d %s", response.Code, response.Body)
	}
	tap.policy.capabilities.Deny = true
	candidate.Revision = "explicit-clear"
	response = outboundControl(tap, completeTestRequest(t, candidate, "clear", json.RawMessage("[]")))
	if response.Code != http.StatusOK || response.Header().Get("ETag") != outboundETag(candidate.Revision) {
		t.Fatalf("explicit clear was refused: %d %s", response.Code, response.Body)
	}
}

func TestCompleteOutboundAdmissionCapabilityIsIndependent(t *testing.T) {
	tap := startNetwork(t, nil)
	before := tap.policy.active.Load()
	candidate := completeTestSnapshot("extended-admission", extendedAdmission)
	tap.policy.capabilities.Admission = false
	response := outboundControl(tap, completeTestRequest(t, candidate, before.revision, nil))
	if response.Code != http.StatusNotImplemented || tap.policy.active.Load() != before {
		t.Fatalf("missing admission capability changed state: %d %s", response.Code, response.Body)
	}
	tap.policy.capabilities.Admission = true
	response = outboundControl(tap, completeTestRequest(t, candidate, before.revision, nil))
	if response.Code != http.StatusOK || tap.policy.active.Load().extended == nil {
		t.Fatalf("extended admission not installed: %d %s", response.Code, response.Body)
	}
	legacy := outboundControl(tap, httptest.NewRequest(http.MethodGet, outboundStatusPath, nil))
	if legacy.Code != http.StatusNotImplemented {
		t.Fatalf("legacy read represented an extended identity: %d %s", legacy.Code, legacy.Body)
	}
}

func TestCompleteOutboundRestoresPreviouslyAcceptedLegacyPolicy(t *testing.T) {
	manyRules := make([]string, 11)
	for i := range manyRules {
		manyRules[i] = fmt.Sprintf("host%d.example", i)
	}
	for _, tc := range []struct {
		name  string
		rules []string
	}{
		{"legacy rule count", manyRules},
		{"legacy body size", []string{strings.Repeat(" ", 65500-48) + "example.com"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tap := startNetwork(t, nil)
			before := tap.policy.active.Load().revision
			flat, err := json.Marshal(outboundPolicy{Mode: "enabled", AllowNet: tc.rules})
			if err != nil {
				t.Fatal(err)
			}
			res := outboundControl(tap, outboundUpdate(string(flat), outboundETag(before), "legacy-predecessor"))
			if res.Code != http.StatusOK {
				t.Fatalf("legacy write failed: %d", res.Code)
			}
			predecessor := tap.policy.active.Load().completeSnapshot()
			promotion := completeTestSnapshot("promotion", extendedAdmission)
			res = outboundControl(tap, completeTestRequest(t, promotion, predecessor.Revision, nil))
			if res.Code != http.StatusOK {
				t.Fatalf("promotion failed: %d", res.Code)
			}
			predecessor.Revision = "restore-exact-legacy-predecessor"
			body, err := json.Marshal(map[string]any{
				"outbound_v1": map[string]any{"snapshot": predecessor, "restore": true},
			})
			if err != nil {
				t.Fatal(err)
			}
			res = outboundControl(tap, outboundUpdate(string(body), outboundETag(promotion.Revision), predecessor.Revision))
			if res.Code != http.StatusOK || res.Header().Get("ETag") != outboundETag(predecessor.Revision) {
				t.Fatalf("legacy restoration failed: %d %s", res.Code, res.Body)
			}
			actual, err := json.Marshal(tap.policy.active.Load().completeSnapshot())
			want, marshalErr := json.Marshal(predecessor)
			if err != nil || marshalErr != nil || string(actual) != string(want) {
				t.Fatal("restoration changed the predecessor policy")
			}
		})
	}
}

func TestOutboundLegacyBodyLimitSurvivesVersionedFraming(t *testing.T) {
	tap := startNetwork(t, nil)
	before := tap.policy.active.Load()
	flat := `{"mode":"enabled","allow_net":["` + strings.Repeat(" ", maxLegacyOutboundBody) + `example.com"]}`
	res := outboundControl(tap, outboundUpdate(flat, outboundETag(before.revision), "too-large"))
	if res.Code != http.StatusBadRequest || tap.policy.active.Load() != before {
		t.Fatalf("oversized flat write changed policy: %d", res.Code)
	}
}

func TestCompleteOutboundStartupUsesIndependentCapabilityUnion(t *testing.T) {
	const input = `{"config":{"socket_path":"unused.sock"},"outbound_v1":{"snapshot":{"policy":{"mode":"enabled","allow_net":["API.Example.COM"],"deny_net":[]},"revision":"committed","admission":"legacy"},"requirements":{"admission":false,"port":true,"deny":false,"capacity":true}}}`
	config, committed, err := decodeGvproxyStartup([]byte(input))
	if err != nil {
		t.Fatal(err)
	}
	if config.OutboundRevision != "committed" || config.SocketPath != "unused.sock" || committed.compiled != nil || len(committed.AllowNet) != 1 || committed.AllowNet[0] != "API.Example.COM" {
		t.Fatalf("pending requirements altered the legacy snapshot: %v %v", config, committed)
	}
	var previousDecoder GvproxyConfig
	if err := json.Unmarshal([]byte(input), &previousDecoder); err != nil || previousDecoder.SocketPath != "" {
		t.Fatalf("wrapped startup is readable as flat configuration: %+v, %v", previousDecoder, err)
	}
}

func TestCompleteOutboundAcknowledgedPolicyGatesNewGuestTCPAndUDP(t *testing.T) {
	var received atomic.Uint64
	httpTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received.Add(1)
		_, _ = w.Write([]byte("allowed"))
	}))
	t.Cleanup(httpTarget.Close)
	tcpPort := uint16(httpTarget.Listener.Addr().(*net.TCPAddr).Port)
	udpTarget, udpPort := newUDPTestTarget(t)
	cfg := testGvproxyConfig()
	tap := startNetworkWith(t, cfg)
	dial := startGuestStack(t, tap, cfg)
	request := "GET / HTTP/1.0\r\nHost: test.invalid\r\n\r\n"
	before := tap.policy.active.Load().revision

	denied := completeTestSnapshot("deny-both", extendedAdmission)
	denied.Policy.DenyNet = []string{fmt.Sprintf("%s:%d", unlistedIP, tcpPort)}
	if tcpPort != udpPort {
		denied.Policy.DenyNet = append(denied.Policy.DenyNet, fmt.Sprintf("%s:%d", unlistedIP, udpPort))
	}
	disallowedRules, err := json.Marshal(denied.Policy.DenyNet)
	if err != nil {
		t.Fatal(err)
	}
	response := outboundControl(tap, completeTestRequest(t, denied, before, disallowedRules))
	if response.Code != http.StatusOK {
		t.Fatalf("deny update was not acknowledged: %d %s", response.Code, response.Body)
	}
	if _, err := extendedGuestHTTP(dial, tcpPort, request); err == nil || received.Load() != 0 {
		t.Fatalf("guest TCP reached the controlled target with active deny: err=%v requests=%d", err, received.Load())
	}
	assertUDPPolicyDrop(t, tap, udpTarget, unlistedIP, guestSrcPort, udpPort, outboundUserDeny)

	clear := completeTestSnapshot("clear-both", extendedAdmission)
	response = outboundControl(tap, completeTestRequest(t, clear, denied.Revision, json.RawMessage("[]")))
	if response.Code != http.StatusOK {
		t.Fatalf("clear update was not acknowledged: %d %s", response.Code, response.Body)
	}
	if body, err := extendedGuestHTTP(dial, tcpPort, request); err != nil || body != "allowed" || received.Load() != 1 {
		t.Fatalf("guest TCP after clear: body=%q err=%v requests=%d", body, err, received.Load())
	}
	tap.send(t, udpFrame(t, unlistedIP, udpPort, []byte("allowed")))
	udpTarget.receive(t, "allowed")
}
