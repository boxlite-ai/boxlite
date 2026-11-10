// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

func checkpointRESTClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{runtime: runtime, homeDir: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil)), boxes: make(map[string]*sdk.Box)}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestCheckpointClientLifecycleRefusesCorruptJournalAndCancelledAdmission(t *testing.T) {
	for _, scenario := range []string{"cancelled", "corrupt-journal"} {
		t.Run(scenario, func(t *testing.T) {
			client := checkpointRESTClient(t, func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("rejected lifecycle operation reached native REST: %s %s", r.Method, r.URL)
				w.WriteHeader(http.StatusInternalServerError)
			})
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if scenario == "cancelled" {
				cancel()
			} else {
				if err := client.RetireCheckpointTarget(ctx, "target"); err != nil {
					t.Fatal(err)
				}
				paths, err := filepath.Glob(filepath.Join(client.checkpointOperations().Root, "*.json"))
				if err != nil || len(paths) != 1 {
					t.Fatalf("retirement did not persist its journal: %v %v", paths, err)
				}
				if err := os.WriteFile(paths[0], []byte("corrupt journal"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			enabled := true
			calls := map[string]func() error{
				"create": func() error {
					_, _, err := client.Create(ctx, dto.CreateBoxDTO{Id: "target", OutboundEnabled: &enabled})
					return err
				},
				"start":   func() error { _, err := client.Start(ctx, "target", nil, nil); return err },
				"stop":    func() error { return client.Stop(ctx, "target", false) },
				"destroy": func() error { return client.Destroy(ctx, "target") },
				"export":  func() error { _, err := client.ExportBox(ctx, "target", t.TempDir()); return err },
				"capture": func() error { _, _, err := client.ExportCheckpoint(ctx, "target", t.TempDir()); return err },
				"import":  func() error { return client.ImportBox(ctx, "target", "missing.boxlite") },
			}
			if scenario == "cancelled" {
				calls["retire"] = func() error { return client.RetireCheckpointTarget(ctx, "target") }
			}
			for name, call := range calls {
				t.Run(name, func(t *testing.T) {
					if err := call(); err == nil {
						t.Fatal("lifecycle call bypassed checkpoint coordination")
					}
				})
			}
		})
	}
}

func TestCheckpointClientOrdinaryImportUsesNativePresenceAndCachesSuccess(t *testing.T) {
	for _, scenario := range []string{"success", "already-present", "lookup-error", "import-error"} {
		t.Run(scenario, func(t *testing.T) {
			imports := 0
			client := checkpointRESTClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/config" {
					_, _ = io.WriteString(w, `{"capabilities":{"import_enabled":true}}`)
					return
				}
				if r.Method == http.MethodGet {
					if scenario == "already-present" {
						_, _ = io.WriteString(w, checkpointWireBox("existing", "target", "stopped", "alpine:latest"))
					} else if scenario == "lookup-error" {
						w.WriteHeader(http.StatusConflict)
						_, _ = io.WriteString(w, `{"error":{"code":"invalid_state","message":"lookup failed"}}`)
					} else {
						w.WriteHeader(http.StatusNotFound)
						_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"missing"}}`)
					}
					return
				}
				imports++
				if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes/import" || r.URL.Query().Get("name") != "target" {
					t.Errorf("unexpected import: %s %s", r.Method, r.URL)
				}
				if scenario == "import-error" {
					w.WriteHeader(http.StatusConflict)
					_, _ = io.WriteString(w, `{"error":{"code":"invalid_state","message":"import failed"}}`)
					return
				}
				_, _ = io.WriteString(w, checkpointWireBox("accepted", "target", "stopped", "alpine:latest"))
			})
			archive := filepath.Join(t.TempDir(), "source.boxlite")
			if err := os.WriteFile(archive, []byte("archive bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			err := client.ImportBox(t.Context(), "target", archive)
			if scenario == "lookup-error" || scenario == "import-error" {
				if err == nil || client.boxes["target"] != nil {
					t.Fatalf("failed import cached a box: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if scenario == "success" && (client.boxes["target"] == nil || client.boxes["target"].ID() != "accepted") {
				t.Fatal("accepted native handle was not cached")
			}
			wantImports := 1
			if scenario == "already-present" || scenario == "lookup-error" {
				wantImports = 0
			}
			if imports != wantImports {
				t.Fatalf("native import count: got %d, want %d", imports, wantImports)
			}
		})
	}
}

func TestCheckpointClientRestorePropagatesInvalidAdmission(t *testing.T) {
	client := checkpointRESTClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("invalid restore reached native REST")
		w.WriteHeader(http.StatusInternalServerError)
	})
	if _, err := client.RestoreCheckpoint(t.Context(), checkpoint.RestoreRequest{}, "bad-attempt", checkpoint.Artifacts{}, nil); err == nil {
		t.Fatal("client accepted invalid checkpoint restore")
	}
}

func TestCheckpointClientLifecycleUsesNativeRESTUnderTargetLease(t *testing.T) {
	for _, action := range []string{"start", "stop", "export"} {
		for _, scenario := range []string{"success", "lookup-error", "native-error"} {
			t.Run(action+"/"+scenario, func(t *testing.T) {
				nativeCalls := 0
				client := checkpointRESTClient(t, func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.URL.Path == "/v1/config" {
						_, _ = io.WriteString(w, `{"capabilities":{"export_enabled":true}}`)
						return
					}
					if r.Method == http.MethodGet {
						if scenario == "lookup-error" {
							w.WriteHeader(http.StatusNotFound)
							_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"missing"}}`)
						} else {
							_, _ = io.WriteString(w, checkpointWireBox("target", "target", "stopped", "alpine:latest"))
						}
						return
					}
					nativeCalls++
					if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes/target/"+action {
						t.Errorf("unexpected lifecycle request: %s %s", r.Method, r.URL)
					}
					if scenario == "native-error" {
						w.WriteHeader(http.StatusConflict)
						_, _ = io.WriteString(w, `{"error":{"code":"invalid_state","message":"operation rejected"}}`)
						return
					}
					if action == "export" {
						w.Header().Set("Content-Type", "application/octet-stream")
						_, _ = io.WriteString(w, "exported bytes")
					} else {
						_, _ = io.WriteString(w, checkpointWireBox("target", "target", "stopped", "alpine:latest"))
					}
				})
				var err error
				switch action {
				case "start":
					_, err = client.Start(t.Context(), "target", nil, nil)
				case "stop":
					err = client.Stop(t.Context(), "target", false)
					if client.boxes["target"] != nil {
						t.Fatal("stopped or failed native handle remained cached")
					}
				case "export":
					var path string
					path, err = client.ExportBox(t.Context(), "target", t.TempDir())
					if scenario == "success" {
						data, readErr := os.ReadFile(path)
						if readErr != nil || string(data) != "exported bytes" {
							t.Fatalf("export lost its bytes: %q %v", data, readErr)
						}
					}
				}
				if (err == nil) != (scenario == "success") {
					t.Fatalf("%s: %v", scenario, err)
				}
				wantNative := 1
				if scenario == "lookup-error" {
					wantNative = 0
				}
				if nativeCalls != wantNative {
					t.Fatalf("native lifecycle calls: got %d, want %d", nativeCalls, wantNative)
				}
			})
		}
	}
}

func checkpointWireBox(id, name, state, image string) string {
	return fmt.Sprintf(`{"box_id":%q,"name":%q,"status":%q,"image":%q,"cpus":1,"memory_mib":128,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`, id, name, state, image)
}

func TestCheckpointNativeAdapterLookupAndRemoval(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNotFound, http.StatusInternalServerError} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			client := checkpointRESTClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if status != http.StatusOK {
					w.WriteHeader(status)
					code := "internal_error"
					if status == http.StatusNotFound {
						code = "not_found"
					}
					fmt.Fprintf(w, `{"error":{"code":%q,"message":"lookup failed"}}`, code)
					return
				}
				if r.Method == http.MethodDelete {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				_, _ = io.WriteString(w, checkpointWireBox("native-target", "target", "stopped", "alpine:latest"))
			})
			native := nativeCheckpointRecovery{client: client, target: "target"}
			info, err := native.Lookup(t.Context(), "target")
			switch status {
			case http.StatusOK:
				if err != nil || info == nil || info.ID != "native-target" || info.State != "stopped" {
					t.Fatalf("lookup: %#v %v", info, err)
				}
			case http.StatusNotFound:
				if info != nil || err != nil {
					t.Fatalf("missing target: %#v %v", info, err)
				}
			default:
				if err == nil {
					t.Fatal("lookup error was swallowed")
				}
			}
			client.boxes["target"] = &sdk.Box{}
			err = native.Remove(t.Context(), "native-target")
			_, retained := client.boxes["target"]
			if status == http.StatusOK {
				if err != nil || retained {
					t.Fatalf("successful removal retained a handle: %v", err)
				}
			} else if err == nil || !retained {
				t.Fatalf("failed removal changed the cache: %v", err)
			}
		})
	}
}

func TestCheckpointNativeAdapterImportAndPreflight(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			client := checkpointRESTClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/config" {
					_, _ = io.WriteString(w, `{"capabilities":{"import_enabled":true}}`)
					return
				}
				if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes/import" || r.URL.Query().Get("name") != "target" {
					t.Errorf("unexpected import request: %s %s", r.Method, r.URL)
				}
				data, err := io.ReadAll(r.Body)
				if err != nil || string(data) != "checkpoint bytes" {
					t.Errorf("import lost the prepared bytes: %q %v", data, err)
				}
				if fail {
					w.WriteHeader(http.StatusConflict)
					_, _ = io.WriteString(w, `{"error":{"code":"invalid_state","message":"import rejected"}}`)
					return
				}
				_, _ = io.WriteString(w, checkpointWireBox("native-target", "target", "stopped", "alpine:latest"))
			})
			path := filepath.Join(t.TempDir(), "prepared.boxlite")
			if err := os.WriteFile(path, []byte("checkpoint bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			native := nativeCheckpointRecovery{client: client, target: "target"}
			if _, err := native.Import(t.Context(), path, "another-target"); err == nil {
				t.Fatal("adapter accepted a different target")
			}
			id, err := native.Import(t.Context(), path, "target")
			if fail {
				if err == nil || len(client.boxes) != 0 {
					t.Fatalf("failed import cached a handle: %q %v", id, err)
				}
			} else if err != nil || id != "native-target" || client.boxes["target"] == nil {
				t.Fatalf("accepted import was not cached: %q %v", id, err)
			}
			_, err = native.Prepare(t.Context(), &checkpoint.DownloadedArchive{Path: path, Artifact: checkpoint.Artifact{SHA256: strings.Repeat("a", 64), PinnedImage: "alpine@sha256:" + strings.Repeat("b", 64)}}, map[string]string{"BOXLITE_BOX_ID": "target"})
			var sdkError *sdk.Error
			if !errors.As(err, &sdkError) || sdkError.Code != sdk.ErrUnsupported {
				t.Fatalf("REST preflight must refuse local file preparation: %v", err)
			}
		})
	}
}

func TestCheckpointClientExportThroughNativeREST(t *testing.T) {
	for _, scenario := range []string{"success", "lookup-error", "unrecorded-image", "export-error", "invalid-destination"} {
		t.Run(scenario, func(t *testing.T) {
			image := "alpine@sha256:" + strings.Repeat("a", 64)
			client := checkpointRESTClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/v1/config":
					_, _ = io.WriteString(w, `{"capabilities":{"export_enabled":true}}`)
				case scenario == "lookup-error" || (scenario == "export-error" && r.Method == http.MethodPost):
					w.WriteHeader(http.StatusConflict)
					_, _ = io.WriteString(w, `{"error":{"code":"invalid_state","message":"native operation rejected"}}`)
				case r.Method == http.MethodGet:
					selected := image
					if scenario == "unrecorded-image" {
						selected = "alpine:latest"
					}
					_, _ = io.WriteString(w, checkpointWireBox("source", "source", "stopped", selected))
				case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes/source/export":
					w.Header().Set("Content-Type", "application/octet-stream")
					_, _ = io.WriteString(w, "captured disk")
				default:
					t.Errorf("unexpected export request: %s %s", r.Method, r.URL)
				}
			})
			destination := t.TempDir()
			if scenario == "invalid-destination" {
				destination = filepath.Join(destination, "file")
				if err := os.WriteFile(destination, []byte("existing file"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			path, pinned, err := client.ExportCheckpoint(context.Background(), "source", destination)
			if scenario == "success" {
				data, readErr := os.ReadFile(path)
				if err != nil || readErr != nil || string(data) != "captured disk" || pinned != image {
					t.Fatalf("export: %q %q %v %v", path, pinned, err, readErr)
				}
			} else if err == nil {
				t.Fatal("native export failure was swallowed")
			}
		})
	}
}
