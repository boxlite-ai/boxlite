// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
)

func TestCheckpointExportCloudBoxIDReachesSDKHTTP(t *testing.T) {
	// This production ID reached a real cloud export and was incorrectly
	// rejected by the runner's UUID guard before calling the SDK.
	const boxID = "GcjxBaAEHZr1"
	var exports atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer checkpoint-export-test" {
			t.Errorf("SDK request missing bearer authentication: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/config":
			fmt.Fprint(w, `{"capabilities":{"checkpoints_enabled":true}}`)
		case "GET /v1/boxes/" + boxID:
			fmt.Fprintf(w, `{"box_id":%q,"name":%q,"status":"paused","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512}`, boxID, boxID)
		case "POST /v1/boxes/" + boxID + "/checkpoint/export":
			exports.Add(1)
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"error":{"type":"InvalidStateError","code":"invalid_state","message":"export boundary reached"}}`)
		default:
			t.Errorf("unexpected SDK request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL, Credential: sdk.NewApiKeyCredential("checkpoint-export-test")})
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{runtime: runtime, boxes: make(map[string]*sdk.Box)}
	service := &CheckpointService{root: t.TempDir(), native: sdkCheckpointNative{client}, supported: true}
	client.checkpointService = service
	client.checkpointOnce.Do(func() {})
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err = service.Export(ctx, checkpointTestOperation, boxID, checkpointTestOrganization, checkpointTestOperation, io.Discard)
	if !sdk.IsInvalidState(err) || exports.Load() != 1 {
		t.Fatalf("cloud Box ID never reached SDK export: err=%v HTTP exports=%d", err, exports.Load())
	}
	record, err := service.readTransfer(checkpointTestOperation)
	if err != nil || record.BoxID != boxID || record.OrganizationID != checkpointTestOrganization {
		t.Fatalf("export lost source/organization binding: %+v err=%v", record, err)
	}
}

func TestCheckpointExportRejectsInvalidIdentityBeforeEffects(t *testing.T) {
	for _, tc := range []struct {
		name, transfer, box, organization, operation string
	}{
		{"missing box", checkpointTestOperation, "", checkpointTestOrganization, checkpointTestOperation},
		{"traversal box", checkpointTestOperation, "../GcjxBaAEHZr1", checkpointTestOrganization, checkpointTestOperation},
		{"separator box", checkpointTestOperation, "GcjxBaAE/HZr1", checkpointTestOrganization, checkpointTestOperation},
		{"NUL box", checkpointTestOperation, "GcjxBaAEHZr1\x00", checkpointTestOrganization, checkpointTestOperation},
		{"unicode box", checkpointTestOperation, "GcjxBaAEHZrñ", checkpointTestOrganization, checkpointTestOperation},
		{"long box", checkpointTestOperation, strings.Repeat("a", 129), checkpointTestOrganization, checkpointTestOperation},
		{"opaque transfer", "GcjxBaAEHZr1", "GcjxBaAEHZr1", checkpointTestOrganization, "GcjxBaAEHZr1"},
		{"traversal transfer", "../transfer", "GcjxBaAEHZr1", checkpointTestOrganization, "../transfer"},
		{"opaque organization", checkpointTestOperation, "GcjxBaAEHZr1", "GcjxBaAEHZr1", checkpointTestOperation},
		{"traversal organization", checkpointTestOperation, "GcjxBaAEHZr1", "../organization", checkpointTestOperation},
		{"missing operation", checkpointTestOperation, "GcjxBaAEHZr1", checkpointTestOrganization, ""},
		{"opaque operation", checkpointTestOperation, "GcjxBaAEHZr1", checkpointTestOrganization, "GcjxBaAEHZr1"},
		{"different operation", checkpointTestOperation, "GcjxBaAEHZr1", checkpointTestOrganization, checkpointTestResource},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, native, _ := newCheckpointFixture(t)
			err := service.Export(context.Background(), tc.transfer, tc.box, tc.organization, tc.operation, io.Discard)
			if !sdk.IsInvalidArgument(err) || len(native.calls) != 0 {
				t.Fatalf("invalid identity reached native: err=%v calls=%v", err, native.calls)
			}
			entries, err := os.ReadDir(service.root)
			if err != nil || len(entries) != 0 {
				t.Fatalf("invalid identity created staging: entries=%v err=%v", entries, err)
			}
		})
	}
}

func TestCheckpointExportRetainsOpaqueIDAndScopeOnReplay(t *testing.T) {
	for _, boxID := range []string{"GcjxBaAEHZr1", checkpointTestBox, "sb_custom_1", strings.Repeat("a", 128)} {
		t.Run(boxID, func(t *testing.T) {
			service, native, _ := newCheckpointFixture(t)
			export := func(box, organization string) error {
				return service.Export(context.Background(), checkpointTestOperation, box, organization, checkpointTestOperation, io.Discard)
			}
			if err := export(boxID, checkpointTestOrganization); err != nil {
				t.Fatal(err)
			}
			service = &CheckpointService{root: service.root, native: native, supported: true}
			if err := export(boxID, checkpointTestOrganization); err != nil {
				t.Fatalf("persisted replay failed: %v", err)
			}
			if err := export(boxID, checkpointTestResource); !sdk.IsInvalidState(err) {
				t.Fatalf("replay changed organization: %v", err)
			}
			if err := export("OtherBox1234", checkpointTestOrganization); !sdk.IsInvalidState(err) {
				t.Fatalf("replay changed source: %v", err)
			}
			if strings.Join(native.calls, ",") != "export-pair" {
				t.Fatalf("replay/conflict repeated native export: %v", native.calls)
			}
		})
	}
}
