// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package services

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

// boxStartedAt only converts BoxInfo's zero-value convention. The sync decision
// interprets the result together with State from the same BoxInfo snapshot.
func TestBoxStartedAt(t *testing.T) {
	startedAt := time.UnixMilli(1_769_000_000_123)

	tests := []struct {
		name string
		info sdkboxlite.BoxInfo
		want *time.Time
	}{
		{
			name: "box reports a recorded Running transition",
			info: sdkboxlite.BoxInfo{ID: "box-1", PID: 4242, StartedAt: startedAt},
			want: &startedAt,
		},
		{
			name: "box has no recorded Running transition",
			info: sdkboxlite.BoxInfo{ID: "box-1", PID: 4242},
			want: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := boxStartedAt(tt.info)

			switch {
			case tt.want == nil && got != nil:
				t.Fatalf("boxStartedAt() = %s, want nil", got)
			case tt.want != nil && got == nil:
				t.Fatalf("boxStartedAt() = nil, want %s", tt.want)
			case tt.want != nil && !got.Equal(*tt.want):
				t.Fatalf("boxStartedAt() = %s, want %s", got, tt.want)
			}
		})
	}
}

// stubBoxReader serves a fixed set of boxes to the sync loop.
type stubBoxReader struct {
	infos   []sdkboxlite.BoxInfo
	pending map[string]blclient.PulledImage
	cleared []string
}

func (r *stubBoxReader) ListInfo(context.Context) ([]sdkboxlite.BoxInfo, error) {
	return r.infos, nil
}

func (r *stubBoxReader) PendingImageReport(boxId string) (blclient.PulledImage, bool) {
	pulled, ok := r.pending[boxId]
	return pulled, ok
}

func (r *stubBoxReader) ClearPendingImageReport(boxId string) {
	r.cleared = append(r.cleared, boxId)
	delete(r.pending, boxId)
}

// remoteBox builds the wire shape the generated client requires for a Box —
// it rejects a payload missing any required property, so the optional fields
// this test cares about have to travel with the mandatory scaffolding.
func remoteBox(id string, state apiclient.BoxState) map[string]any {
	return map[string]any{
		"id":              id,
		"organizationId":  "org-1",
		"name":            id,
		"user":            "boxlite",
		"env":             map[string]string{},
		"labels":          map[string]string{},
		"public":          false,
		"networkBlockAll": false,
		"target":          "eu",
		"cpu":             1,
		"gpu":             0,
		"memory":          1,
		"disk":            1,
		"toolboxProxyUrl": "https://proxy.invalid",
		"state":           string(state),
	}
}

// runnerAPIStub records the state updates the sync loop pushes and can be told
// to reject the transitional-state query the way an older API does.
type runnerAPIStub struct {
	transitionalBoxes    []map[string]any
	rejectTransitional   bool
	startedBoxes         []map[string]any
	updates              map[string]string
	updateBodies         map[string]map[string]any
	transitionalRequests int
}

func (s *runnerAPIStub) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")

		if request.Method == http.MethodGet && request.URL.Path == "/box/for-runner" {
			if request.URL.Query().Get("states") == string(apiclient.BOXSTATE_STARTED) {
				_ = json.NewEncoder(response).Encode(s.startedBoxes)
				return
			}
			s.transitionalRequests++
			if s.rejectTransitional {
				response.WriteHeader(http.StatusBadRequest)
				_, _ = response.Write([]byte(`{"message":"State creating does not have a corresponding desired state"}`))
				return
			}
			_ = json.NewEncoder(response).Encode(s.transitionalBoxes)
			return
		}

		if request.Method == http.MethodPut {
			var raw map[string]any
			if err := json.NewDecoder(request.Body).Decode(&raw); err != nil {
				t.Errorf("decode state update: %v", err)
			}
			if s.updates == nil {
				s.updates = map[string]string{}
				s.updateBodies = map[string]map[string]any{}
			}
			// /box/{boxId}/state
			state, _ := raw["state"].(string)
			s.updates[request.URL.Path] = state
			s.updateBodies[request.URL.Path] = raw
			response.WriteHeader(http.StatusOK)
			return
		}

		t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
		response.WriteHeader(http.StatusNotFound)
	})
}

func newSyncServiceForTest(
	server *httptest.Server,
	reader boxStateReader,
) *BoxSyncService {
	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
	config.HTTPClient = server.Client()

	return &BoxSyncService{
		log:     slog.Default(),
		boxlite: reader,
		client:  apiclient.NewAPIClient(config),
	}
}

func TestPerformSyncConfirmsTransitionalBoxOnlyWithARecordedStart(t *testing.T) {
	tests := []struct {
		name          string
		startedAt     time.Time
		wantStateSent bool
	}{
		{name: "box start recorded", startedAt: time.Now(), wantStateSent: true},
		{name: "Running without a recorded start", wantStateSent: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := &runnerAPIStub{
				startedBoxes: []map[string]any{},
				transitionalBoxes: []map[string]any{
					remoteBox("box-1", apiclient.BOXSTATE_CREATING),
				},
			}
			server := httptest.NewServer(api.handler(t))
			defer server.Close()

			reader := &stubBoxReader{
				infos: []sdkboxlite.BoxInfo{{
					ID:        "box-1",
					State:     sdkboxlite.StateRunning,
					PID:       77,
					StartedAt: tt.startedAt,
				}},
			}

			service := newSyncServiceForTest(server, reader)
			if err := service.PerformSync(context.Background()); err != nil {
				t.Fatalf("PerformSync: %v", err)
			}

			sentState, sent := api.updates["/box/box-1/state"]
			if sent != tt.wantStateSent {
				t.Fatalf("state update sent = %v (%q), want %v", sent, sentState, tt.wantStateSent)
			}
			if tt.wantStateSent && sentState != string(apiclient.BOXSTATE_STARTED) {
				t.Fatalf("reported state = %q, want %q", sentState, apiclient.BOXSTATE_STARTED)
			}
		})
	}
}

// An API that predates the transitional-state query rejects it. The
// long-standing STARTED reconciliation must survive that on its own.
// The report of what a box's image resolved to cannot ride on a state
// mismatch: the control plane also learns a box is up by polling this runner,
// and whichever observation lands first leaves the other with nothing to say.
// So a box that owes one is pushed even when both sides already agree, and the
// report is dropped only once it has been delivered.
func TestPerformSyncReportsAResolvedImageEvenWhenStatesAgree(t *testing.T) {
	api := &runnerAPIStub{
		startedBoxes:      []map[string]any{remoteBox("box-1", apiclient.BOXSTATE_STARTED)},
		transitionalBoxes: []map[string]any{},
	}
	server := httptest.NewServer(api.handler(t))
	defer server.Close()

	reader := &stubBoxReader{
		infos: []sdkboxlite.BoxInfo{{
			ID:        "box-1",
			State:     sdkboxlite.StateRunning,
			PID:       77,
			StartedAt: time.Now(),
		}},
		pending: map[string]blclient.PulledImage{
			"box-1": {Digest: "sha256:abc", SizeBytes: 4096},
		},
	}

	service := newSyncServiceForTest(server, reader)
	if err := service.PerformSync(context.Background()); err != nil {
		t.Fatalf("PerformSync: %v", err)
	}

	body, sent := api.updateBodies["/box/box-1/state"]
	if !sent {
		t.Fatal("a box owing an image report must be pushed even with matching states")
	}
	if body["imageDigest"] != "sha256:abc" {
		t.Errorf("imageDigest = %v, want sha256:abc", body["imageDigest"])
	}
	if body["imageSizeBytes"] != float64(4096) {
		t.Errorf("imageSizeBytes = %v, want 4096", body["imageSizeBytes"])
	}
	if len(reader.cleared) != 1 || reader.cleared[0] != "box-1" {
		t.Errorf("a delivered report must be cleared, got %v", reader.cleared)
	}
}

// A push that did not carry the report must not consume it. A box that reaches
// STOPPED before anyone reported its image would otherwise lose the report to a
// state update that never contained it.
func TestPerformSyncKeepsAnUncarriedImageReport(t *testing.T) {
	api := &runnerAPIStub{
		startedBoxes:      []map[string]any{remoteBox("box-1", apiclient.BOXSTATE_STARTED)},
		transitionalBoxes: []map[string]any{},
	}
	server := httptest.NewServer(api.handler(t))
	defer server.Close()

	reader := &stubBoxReader{
		infos: []sdkboxlite.BoxInfo{{ID: "box-1", State: sdkboxlite.StateStopped}},
		pending: map[string]blclient.PulledImage{
			"box-1": {Digest: "sha256:abc", SizeBytes: 4096},
		},
	}

	service := newSyncServiceForTest(server, reader)
	if err := service.PerformSync(context.Background()); err != nil {
		t.Fatalf("PerformSync: %v", err)
	}

	body := api.updateBodies["/box/box-1/state"]
	if _, carried := body["imageDigest"]; carried {
		t.Error("a stopped box must not report an image it never started")
	}
	if len(reader.cleared) != 0 {
		t.Errorf("a report that was not sent must survive, got cleared %v", reader.cleared)
	}
}

// A box nobody is waiting on a report for keeps the old behaviour: nothing is
// pushed while the two sides agree.
func TestPerformSyncStaysQuietWhenStatesAgreeAndNothingIsOwed(t *testing.T) {
	api := &runnerAPIStub{
		startedBoxes:      []map[string]any{remoteBox("box-1", apiclient.BOXSTATE_STARTED)},
		transitionalBoxes: []map[string]any{},
	}
	server := httptest.NewServer(api.handler(t))
	defer server.Close()

	reader := &stubBoxReader{
		infos: []sdkboxlite.BoxInfo{{
			ID:        "box-1",
			State:     sdkboxlite.StateRunning,
			PID:       77,
			StartedAt: time.Now(),
		}},
	}

	service := newSyncServiceForTest(server, reader)
	if err := service.PerformSync(context.Background()); err != nil {
		t.Fatalf("PerformSync: %v", err)
	}

	if _, sent := api.updates["/box/box-1/state"]; sent {
		t.Error("matching states with nothing owed must not push a state update")
	}
}

func TestPerformSyncStillReconcilesStartedBoxesWhenTransitionalQueryIsRejected(t *testing.T) {
	api := &runnerAPIStub{
		rejectTransitional: true,
		startedBoxes: []map[string]any{
			remoteBox("box-gone", apiclient.BOXSTATE_STARTED),
		},
	}
	server := httptest.NewServer(api.handler(t))
	defer server.Close()

	reader := &stubBoxReader{
		infos: []sdkboxlite.BoxInfo{{ID: "box-gone", State: sdkboxlite.StateStopped, PID: 0}},
	}

	service := newSyncServiceForTest(server, reader)
	if err := service.PerformSync(context.Background()); err != nil {
		t.Fatalf("PerformSync must not fail when the transitional query is rejected: %v", err)
	}

	if api.transitionalRequests == 0 {
		t.Fatal("transitional query was never attempted")
	}
	if got := api.updates["/box/box-gone/state"]; got != string(apiclient.BOXSTATE_STOPPED) {
		t.Fatalf("stopped box reported as %q, want %q", got, apiclient.BOXSTATE_STOPPED)
	}
}
