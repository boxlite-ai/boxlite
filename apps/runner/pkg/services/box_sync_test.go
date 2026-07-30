// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

// writeStartedRecord lays down the file BoxLite writes after a successful
// guest Container.Start, in the layout box_impl.rs uses.
func writeStartedRecord(t *testing.T, homeDir string, boxID string, contents string) {
	t.Helper()
	boxDir := filepath.Join(homeDir, "boxes", boxID)
	if err := os.MkdirAll(boxDir, 0o755); err != nil {
		t.Fatalf("create box dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(boxDir, "started"), []byte(contents), 0o644); err != nil {
		t.Fatalf("write start record: %v", err)
	}
}

func TestReadStartedRecord(t *testing.T) {
	const livePID = 4242
	startedAt := time.UnixMilli(1_769_000_000_123)

	tests := []struct {
		name     string
		contents string
		// omitRecord skips writing the file entirely.
		omitRecord bool
		livePID    int
		want       *time.Time
	}{
		{
			name:     "record written by the live shim",
			contents: fmt.Sprintf(`{"pid":%d,"at_unix_ms":%d}`, livePID, startedAt.UnixMilli()),
			livePID:  livePID,
			want:     &startedAt,
		},
		{
			name:     "record left by a previous shim",
			contents: fmt.Sprintf(`{"pid":%d,"at_unix_ms":%d}`, livePID-1, startedAt.UnixMilli()),
			livePID:  livePID,
			want:     nil,
		},
		{
			name:       "no record at all",
			omitRecord: true,
			livePID:    livePID,
			want:       nil,
		},
		{
			name:     "truncated record",
			contents: `{"pid":4242,"at_un`,
			livePID:  livePID,
			want:     nil,
		},
		{
			name:     "record without a timestamp",
			contents: fmt.Sprintf(`{"pid":%d}`, livePID),
			livePID:  livePID,
			want:     nil,
		},
		{
			name:     "box has no live pid",
			contents: fmt.Sprintf(`{"pid":%d,"at_unix_ms":%d}`, livePID, startedAt.UnixMilli()),
			livePID:  0,
			want:     nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			homeDir := t.TempDir()
			if !tt.omitRecord {
				writeStartedRecord(t, homeDir, "box-1", tt.contents)
			}

			got := readStartedRecord(homeDir, "box-1", tt.livePID)

			switch {
			case tt.want == nil && got != nil:
				t.Fatalf("readStartedRecord() = %s, want nil", got)
			case tt.want != nil && got == nil:
				t.Fatalf("readStartedRecord() = nil, want %s", tt.want)
			case tt.want != nil && !got.Equal(*tt.want):
				t.Fatalf("readStartedRecord() = %s, want %s", got, tt.want)
			}
		})
	}
}

// stubBoxReader serves a fixed set of boxes to the sync loop.
type stubBoxReader struct {
	infos  []sdkboxlite.BoxInfo
	states map[string]enums.BoxState
}

func (r *stubBoxReader) ListInfo(context.Context) ([]sdkboxlite.BoxInfo, error) {
	return r.infos, nil
}

func (r *stubBoxReader) GetBoxState(_ context.Context, boxID string) (enums.BoxState, error) {
	state, ok := r.states[boxID]
	if !ok {
		return enums.BoxStateUnknown, fmt.Errorf("box %s not found", boxID)
	}
	return state, nil
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
			var body struct {
				State string `json:"state"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode state update: %v", err)
			}
			if s.updates == nil {
				s.updates = map[string]string{}
			}
			// /box/{boxId}/state
			s.updates[request.URL.Path] = body.State
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
	homeDir string,
) *BoxSyncService {
	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: server.URL}}
	config.HTTPClient = server.Client()

	return &BoxSyncService{
		log:     slog.Default(),
		boxlite: reader,
		homeDir: homeDir,
		client:  apiclient.NewAPIClient(config),
	}
}

func TestPerformSyncConfirmsTransitionalBoxOnlyWithAStartRecord(t *testing.T) {
	tests := []struct {
		name          string
		writeRecord   bool
		recordPID     int
		wantStateSent bool
	}{
		{name: "start record matches the live shim", writeRecord: true, recordPID: 77, wantStateSent: true},
		{name: "no start record", writeRecord: false, wantStateSent: false},
		{name: "start record names a dead shim", writeRecord: true, recordPID: 76, wantStateSent: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			homeDir := t.TempDir()
			if tt.writeRecord {
				writeStartedRecord(t, homeDir, "box-1",
					fmt.Sprintf(`{"pid":%d,"at_unix_ms":%d}`, tt.recordPID, time.Now().UnixMilli()))
			}

			api := &runnerAPIStub{
				startedBoxes: []map[string]any{},
				transitionalBoxes: []map[string]any{
					remoteBox("box-1", apiclient.BOXSTATE_CREATING),
				},
			}
			server := httptest.NewServer(api.handler(t))
			defer server.Close()

			reader := &stubBoxReader{
				infos:  []sdkboxlite.BoxInfo{{ID: "box-1", State: sdkboxlite.StateRunning, PID: 77}},
				states: map[string]enums.BoxState{"box-1": enums.BoxStateStarted},
			}

			service := newSyncServiceForTest(server, reader, homeDir)
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
		infos:  []sdkboxlite.BoxInfo{{ID: "box-gone", State: sdkboxlite.StateStopped, PID: 0}},
		states: map[string]enums.BoxState{"box-gone": enums.BoxStateStopped},
	}

	service := newSyncServiceForTest(server, reader, t.TempDir())
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
