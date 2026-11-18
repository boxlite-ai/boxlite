package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func outboundControl(tap *guestTap, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	tap.policy.ServeHTTP(response, request)
	return response
}

func outboundUpdate(body, condition, candidate string) *http.Request {
	path := "/network/outbound"
	if candidate != "" {
		path = "/network/outbound/snapshot"
	}
	request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	if condition != "" {
		request.Header.Set("If-Match", condition)
	}
	if candidate != "" {
		request.Header.Set("X-Boxlite-Outbound-Revision", candidate)
	}
	return request
}

func TestOutboundRevisionHeaderContract(t *testing.T) {
	for _, tc := range []struct {
		name, condition, candidate string
		status                     int
	}{
		{"legacy-unconditional", "", "", 200},
		{"matching-cas", `"initial"`, "rev-b", 200},
		{"stale-cas", `"stale"`, "rev-b", 412},
		{"candidate-needs-expected", "", "rev-b", 400},
		{"candidate-rejects-wildcard", "*", "rev-b", 400},
		{"candidate-rejects-weak", `W/"initial"`, "rev-b", 400},
		{"candidate-rejects-list", `"old", "initial"`, "rev-b", 400},
		{"candidate-rejects-initial", `"initial"`, "initial", 400},
		{"candidate-rejects-long", `"initial"`, strings.Repeat("a", 129), 400},
		{"candidate-rejects-control", `"initial"`, "bad\r\nrevision", 400},
		{"weak-is-not-strong", `W/"initial"`, "", 412},
		{"legacy-list", `"old", "initial"`, "", 200},
		{"legacy-opaque-comma", `"other,tag", "initial"`, "", 200},
		{"legacy-wildcard", "*", "", 200},
		{"legacy-leading-empty", `, "initial"`, "", 200},
		{"legacy-interior-empty", `"old",, "initial"`, "", 200},
		{"legacy-trailing-empty", `"initial",`, "", 200},
		{"legacy-only-empty", ", ,", "", 412},
		{"legacy-rejects-non-http-prefix", "\u00a0\"initial\"", "", 412},
		{"legacy-rejects-non-http-after-tag", "\"initial\"\u00a0, \"old\"", "", 412},
		{"legacy-rejects-non-http-after-comma", "\"old\",\u00a0\"initial\"", "", 412},
		{"candidate-rejects-non-http-whitespace", "\u00a0\"initial\"\u00a0", "rev-b", 400},
		{"candidate-accepts-http-whitespace", " \t\"initial\"\t ", "rev-b", 200},
		{"candidate-rejects-empty-elements", `, "initial",`, "rev-b", 400},
		{"rejects-malformed-tail", `"initial", broken`, "", 412},
		{"rejects-unquoted", "initial", "", 412},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tap := startNetwork(t, nil)
			response := outboundControl(tap, outboundUpdate(`{"mode":"enabled","allow_net":["after.example"]}`, tc.condition, tc.candidate))
			if response.Code != tc.status {
				t.Fatalf("update: status=%d body=%s", response.Code, response.Body)
			}
			read := outboundControl(tap, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
			if read.Code != http.StatusOK {
				t.Fatalf("policy read: %d %s", read.Code, read.Body)
			}
			if tc.status == 200 {
				if tag := response.Header().Get("ETag"); tag == "" || tag == `"initial"` || tag != read.Header().Get("ETag") {
					t.Fatalf("matching applied/readback identity: ack=%q read=%q", tag, read.Header().Get("ETag"))
				}
				if tc.candidate != "" && response.Header().Get("ETag") != `"`+tc.candidate+`"` {
					t.Fatalf("candidate identity changed: %q", response.Header().Get("ETag"))
				}
			} else if read.Header().Get("ETag") != `"initial"` || strings.Contains(read.Body.String(), "after.example") {
				t.Fatalf("rejected request changed state: %s %s", read.Header().Get("ETag"), read.Body)
			}
			var policy map[string]json.RawMessage
			if err := json.Unmarshal(read.Body.Bytes(), &policy); err != nil || len(policy) != 2 || policy["mode"] == nil || policy["allow_net"] == nil {
				t.Fatalf("policy response contains metadata or changed shape: %s err=%v", read.Body, err)
			}
		})
	}
}

func TestOutboundRevisionSharedRestorationContract(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "outbound", "contract-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			ID                   string `json:"id"`
			Expected             string `json:"expected_revision"`
			Candidate            string `json:"candidate_revision"`
			CompensationExpected string `json:"compensation_expected_revision"`
			Restoration          string `json:"restoration_revision"`
		} `json:"replacement_cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, example := range fixture.Cases {
		if example.ID != "conditional-restoration" {
			continue
		}
		found = true
		cfg := testGvproxyConfig()
		cfg.OutboundRevision = example.Expected
		tap := startNetworkWith(t, cfg)
		applied := outboundControl(tap, outboundUpdate(`{"mode":"disabled"}`, `"`+example.Expected+`"`, example.Candidate))
		if applied.Code != 200 || applied.Header().Get("ETag") != `"`+example.Candidate+`"` {
			t.Fatalf("apply candidate: %d %s", applied.Code, applied.Body)
		}
		restored := outboundControl(tap, outboundUpdate(`{"mode":"enabled"}`, `"`+example.CompensationExpected+`"`, example.Restoration))
		if restored.Code != 200 || restored.Header().Get("ETag") != `"`+example.Restoration+`"` {
			t.Fatalf("restore with fresh identity: %d %s", restored.Code, restored.Body)
		}
		stale := outboundControl(tap, outboundUpdate(`{"mode":"disabled"}`, `"`+example.Expected+`"`, "rev-late"))
		if stale.Code != http.StatusPreconditionFailed {
			t.Fatalf("restoration reopened the old precondition: %d", stale.Code)
		}
	}
	if !found {
		t.Fatal("missing shared conditional-restoration example")
	}
}

func TestOutboundRevisionPendingIsNotAnAcknowledgement(t *testing.T) {
	tap := startNetwork(t, nil)
	paused := &pausedNICOperations{nicOperations: tap.policy.stack,
		entered: make(chan string, 1), resume: make(chan struct{})}
	var once sync.Once
	release := func() { once.Do(func() { close(paused.resume) }) }
	t.Cleanup(release)
	tap.policy.nicOps = paused
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- outboundControl(tap, outboundUpdate(`{"mode":"disabled"}`, `"initial"`, "rev-b")) }()
	select {
	case <-paused.entered:
	case <-time.After(forwardWindow):
		t.Fatal("candidate did not enter NIC transition")
	}
	status := outboundControl(tap, httptest.NewRequest(http.MethodGet, "/network/outbound/status", nil))
	var observed struct {
		Revision     string   `json:"revision"`
		State        string   `json:"application_state"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(status.Body.Bytes(), &observed); err != nil || status.Code != 200 || observed.Revision != "rev-b" || observed.State != "pending" || len(observed.Capabilities) != 1 || observed.Capabilities[0] != "revision-v1" {
		t.Fatalf("pending status: %d %s err=%v", status.Code, status.Body, err)
	}
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() { second <- outboundControl(tap, outboundUpdate(`{"mode":"enabled"}`, `"initial"`, "rev-c")) }()
	select {
	case response := <-done:
		t.Fatalf("candidate was acknowledged before NIC completion: %d", response.Code)
	default:
	}
	release()
	select {
	case response := <-done:
		if response.Code != 200 || response.Header().Get("ETag") != `"rev-b"` {
			t.Fatalf("completed ack: %d %s", response.Code, response.Body)
		}
	case <-time.After(forwardWindow):
		t.Fatal("released candidate did not complete")
	}
	select {
	case response := <-second:
		if response.Code != 412 {
			t.Fatalf("queued stale update won: %d %s", response.Code, response.Body)
		}
	case <-time.After(forwardWindow):
		t.Fatal("queued stale update did not complete")
	}
}

func TestOutboundRevisionStaleWriteCannotReopenTraffic(t *testing.T) {
	tap := startNetwork(t, nil)
	response := outboundControl(tap, outboundUpdate(`{"mode":"disabled"}`, `"initial"`, "rev-b"))
	if response.Code != 200 {
		t.Fatalf("disable: %d %s", response.Code, response.Body)
	}
	response = outboundControl(tap, outboundUpdate(`{"mode":"enabled"}`, `"initial"`, "rev-c"))
	if response.Code != 412 {
		t.Fatalf("stale enable: %d %s", response.Code, response.Body)
	}
	upstream, port := listenUDP(t)
	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))
	assertDatagramDropped(t, upstream, "traffic after a stale enable")
	response = outboundControl(tap, outboundUpdate(`{"mode":"enabled"}`, `"rev-b"`, "rev-d"))
	if response.Code != 200 {
		t.Fatalf("current enable: %d %s", response.Code, response.Body)
	}
	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))
	receivePolicyProbe(t, upstream, []byte(probePayload))
}

func TestOutboundRevisionStartupIdentity(t *testing.T) {
	cfg := testGvproxyConfig()
	cfg.OutboundRevision = "restored-revision"
	tap := startNetworkWith(t, cfg)
	read := outboundControl(tap, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
	if read.Header().Get("ETag") != `"restored-revision"` {
		t.Fatalf("restored identity was replaced: %s", read.Header().Get("ETag"))
	}
	cfg.OutboundRevision = ""
	previous := ""
	for range 2 {
		fresh := startNetworkWith(t, cfg)
		read = outboundControl(fresh, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
		tag := read.Header().Get("ETag")
		if len(tag) != 34 || tag == previous {
			t.Fatalf("unseeded startup must receive a fresh identity: %q, previous %q", tag, previous)
		}
		previous = tag
	}
}

func TestOutboundRevisionFailureStatusIsCompletionQualified(t *testing.T) {
	tap := startNetwork(t, nil)
	tap.policy.nic += 1000
	failed := outboundControl(tap, outboundUpdate(`{"mode":"disabled"}`, `"initial"`, "rev-b"))
	if failed.Code != 500 || failed.Header().Get("ETag") != "" {
		t.Fatalf("failed transition produced an acknowledgement: %d %q", failed.Code, failed.Header().Get("ETag"))
	}
	status := outboundControl(tap, httptest.NewRequest(http.MethodGet, "/network/outbound/status", nil))
	var observed struct {
		Revision string `json:"revision"`
		State    string `json:"application_state"`
	}
	if err := json.Unmarshal(status.Body.Bytes(), &observed); err != nil || status.Code != 200 || observed.Revision != "rev-b" || observed.State != "uncertain" {
		t.Fatalf("candidate identity without completion must remain uncertain: %d %s err=%v", status.Code, status.Body, err)
	}
	writeStatus := outboundControl(tap, httptest.NewRequest(http.MethodPut, "/network/outbound/status", strings.NewReader(`{"mode":"enabled"}`)))
	if writeStatus.Code != 405 {
		t.Fatalf("status resource accepted a write: %d", writeStatus.Code)
	}
}

func TestOutboundRevisionRejectsReusedAndAmbiguousCandidates(t *testing.T) {
	tap := startNetwork(t, nil)
	if response := outboundControl(tap, outboundUpdate(`{"mode":"enabled"}`, `"initial"`, "rev-b")); response.Code != 200 {
		t.Fatalf("candidate setup: %d %s", response.Code, response.Body)
	}
	for _, candidate := range []string{"rev-b", ""} {
		request := outboundUpdate(`{"mode":"disabled"}`, `"rev-b"`, "")
		request.URL.Path = "/network/outbound/snapshot"
		request.Header.Add("X-Boxlite-Outbound-Revision", candidate)
		if response := outboundControl(tap, request); response.Code != 400 {
			t.Fatalf("reused or empty candidate: %d %s", response.Code, response.Body)
		}
	}
	request := outboundUpdate(`{"mode":"disabled"}`, `"rev-b"`, "rev-c")
	request.Header.Add("X-Boxlite-Outbound-Revision", "rev-d")
	if response := outboundControl(tap, request); response.Code != 400 {
		t.Fatalf("ambiguous candidate: %d %s", response.Code, response.Body)
	}
	read := outboundControl(tap, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
	if read.Code != 200 || read.Header().Get("ETag") != `"rev-b"` || strings.Contains(read.Body.String(), "disabled") {
		t.Fatalf("invalid candidate mutated state: %d %s", read.Code, read.Body)
	}
}

func TestOutboundRevisionSnapshotCannotDegradeToLegacyUpdate(t *testing.T) {
	tap := startNetwork(t, nil)
	missing := outboundUpdate(`{"mode":"disabled"}`, `"initial"`, "")
	missing.URL.Path = "/network/outbound/snapshot"
	if response := outboundControl(tap, missing); response.Code != 400 {
		t.Fatalf("snapshot resource accepted missing coordinator metadata: %d", response.Code)
	}
	wrong := outboundUpdate(`{"mode":"disabled"}`, `"initial"`, "rev-b")
	wrong.URL.Path = "/network/outbound"
	if response := outboundControl(tap, wrong); response.Code != 400 {
		t.Fatalf("legacy resource accepted a versioned operation: %d", response.Code)
	}
	read := outboundControl(tap, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
	if read.Code != 200 || read.Header().Get("ETag") != `"initial"` {
		t.Fatalf("invalid versioned request changed policy: %d %s", read.Code, read.Body)
	}
}
