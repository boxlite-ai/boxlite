package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func replacePolicy(t *testing.T, tap *guestTap, body string, wantStatus int) {
	t.Helper()
	response := httptest.NewRecorder()
	tap.policy.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/network/outbound", strings.NewReader(body)))
	if response.Code != wantStatus {
		t.Fatalf("policy response %d: %s", response.Code, response.Body)
	}
}

func TestOutboundPolicyUDPReplacementAndDisable(t *testing.T) {
	tap := startNetwork(t, nil)
	for _, step := range []struct {
		body    string
		allowed bool
	}{
		{`{"mode":"enabled","allow_net":["198.51.100.9"]}`, true},
		{`{"mode":"enabled","allow_net":["example.com"]}`, false},
		{`{"mode":"enabled"}`, true},
		{`{"mode":"disabled"}`, false},
		{`{"mode":"enabled"}`, true},
	} {
		replacePolicy(t, tap, step.body, http.StatusOK)
		// A new destination port creates a new UDP flow each time.
		conn, port := listenUDP(t)
		tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))
		if !step.allowed {
			assertDatagramDropped(t, conn, "updated policy %s", step.body)
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(forwardWindow))
		buf := make([]byte, 1024)
		n, _, err := conn.ReadFrom(buf)
		if err != nil || string(buf[:n]) != probePayload {
			t.Fatalf("allowed UDP after %s: payload=%q error=%v", step.body, buf[:n], err)
		}
	}
}

func TestOutboundPolicyTCPReplacement(t *testing.T) {
	tap := startNetwork(t, nil)
	dial := startGuestStack(t, tap, testGvproxyConfig())
	listener, port := listenTCP(t)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	established, err := dial(unlistedIP, port)
	if err != nil {
		t.Fatal(err)
	}
	defer established.Close()
	echo := func() {
		t.Helper()
		_ = established.SetDeadline(time.Now().Add(forwardWindow))
		if _, err := established.Write([]byte("existing")); err != nil {
			t.Fatal(err)
		}
		response := make([]byte, len("existing"))
		if _, err := io.ReadFull(established, response); err != nil || string(response) != "existing" {
			t.Fatalf("established flow interrupted: response=%q error=%v", response, err)
		}
	}
	echo()
	for _, step := range []struct {
		body    string
		allowed bool
	}{
		{`{"mode":"enabled","allow_net":["198.51.100.9"]}`, true},
		{`{"mode":"enabled","allow_net":["example.com"]}`, false},
		{`{"mode":"enabled","allow_net":[]}`, true},
	} {
		replacePolicy(t, tap, step.body, http.StatusOK)
		conn, err := dial(unlistedIP, port)
		if err == nil {
			_ = conn.SetDeadline(time.Now().Add(forwardWindow))
			_, err = conn.Write([]byte("probe"))
			if err == nil {
				response := make([]byte, 5)
				_, err = io.ReadFull(conn, response)
				if err == nil && string(response) != "probe" {
					t.Fatal("bad echo")
				}
			}
			_ = conn.Close()
		}
		if (err == nil) != step.allowed {
			t.Fatalf("TCP after %s: %v", step.body, err)
		}
		echo()
	}
}

func TestOutboundPolicyRejectsInvalidReplacementWithoutChangingCurrent(t *testing.T) {
	tap := startNetwork(t, []string{"example.com"})
	for _, body := range []string{
		`{}`, `{"mode":"off"}`, `{"mode":"disabled","allow_net":["example.com"]}`,
		`{"mode":"enabled","allow_net":[""]}`, `{"mode":"enabled","allow_net":["10.0.0.0/33"]}`,
		`{"mode":"enabled","allow_net":["a.com,b.com"]}`, `{"mode":"enabled","unknown":true}`,
		`{"mode":"enabled"}{}`,
	} {
		replacePolicy(t, tap, body, http.StatusBadRequest)
	}
	response := httptest.NewRecorder()
	tap.policy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
	var policy outboundPolicy
	if err := json.Unmarshal(response.Body.Bytes(), &policy); err != nil {
		t.Fatal(err)
	}
	if policy.Mode != "enabled" || len(policy.AllowNet) != 1 || policy.AllowNet[0] != "example.com" {
		t.Fatalf("invalid request changed policy: %+v", policy)
	}
}

// Create accepts padded rules and the filter trims them, so a replacement
// carrying a saved padded rule must be accepted too.
func TestOutboundPolicyAcceptsPaddedRules(t *testing.T) {
	tap := startNetwork(t, nil)
	replacePolicy(t, tap, `{"mode":"enabled","allow_net":[" example.com ","10.0.0.0/8 "]}`, http.StatusOK)
	replacePolicy(t, tap, `{"mode":"enabled","allow_net":["  "]}`, http.StatusBadRequest)
}

func TestOutboundPolicyInitialEmptyListIsAnArray(t *testing.T) {
	tap := startNetwork(t, nil)
	response := httptest.NewRecorder()
	tap.policy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
	if strings.Contains(response.Body.String(), "null") {
		t.Fatalf("initial policy must be readable by SDK Vec fields: %s", response.Body)
	}
}
