//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// Start outside ExecManager, then recover the real guest IDs through HTTP.
// This is the same ownership gap a client/server restart creates.
func TestIntegrationExecutionInventoryRecoveryHTTP(t *testing.T) {
	ctx := context.Background()
	runtime, err := sdk.NewRuntime(sdk.WithHomeDir(t.TempDir()))
	if err != nil {
		var runtimeErr *sdk.Error
		if errors.As(err, &runtimeErr) && runtimeErr.Code == sdk.ErrUnsupported {
			t.Skipf("virtualization prerequisite unavailable: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close() })
	box, err := runtime.Create(ctx, "alpine:latest",
		sdk.WithName("e2e-api-box"), sdk.WithCPUs(1), sdk.WithMemory(512), sdk.WithAutoRemove(false),
		sdk.WithCmd("sh", "-c", "while true; do echo recovered-main; sleep 0.1; done"))
	if err != nil {
		var createErr *sdk.Error
		if errors.As(err, &createErr) && (createErr.Code == sdk.ErrStorage || createErr.Code == sdk.ErrImage || createErr.Code == sdk.ErrNetwork) {
			t.Skipf("image prerequisite unavailable: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = runtime.ForceRemove(context.Background(), box.ID())
		_ = box.Close()
	})
	if err := box.Start(ctx); err != nil {
		var startErr *sdk.Error
		if errors.As(err, &startErr) && (startErr.Code == sdk.ErrStorage || startErr.Code == sdk.ErrImage || startErr.Code == sdk.ErrNetwork) {
			t.Skipf("boot prerequisite unavailable: %v", err)
		}
		t.Fatal(err)
	}
	execution, err := box.StartExecution(ctx, "sleep", []string{"300"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = execution.Close() })

	manager := withFreshExecManager(t)
	t.Cleanup(manager.Stop)
	previous := getExecutionBox
	getExecutionBox = func(_ *gin.Context, id string) (*sdk.Box, error) {
		if id != box.Name() {
			return nil, &sdk.Error{Code: sdk.ErrNotFound, Message: "box not found"}
		}
		return box, nil
	}
	t.Cleanup(func() { getExecutionBox = previous })
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/v1/boxes/:boxId/executions", BoxliteListExecutions)
	router.GET("/v1/boxes/:boxId/executions/:execId", BoxliteGetExecution)
	router.GET("/v1/boxes/:boxId/executions/:execId/attach", BoxliteExecAttach)
	router.DELETE("/v1/boxes/:boxId/executions/:execId", BoxliteExecKill)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	base := "/v1/boxes/" + box.Name() + "/executions"
	request := func(method, path string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(method, path, nil))
		return response
	}
	inventory := func() []sdk.ExecutionInfo {
		t.Helper()
		response := request(http.MethodGet, base)
		if response.Code != http.StatusOK {
			t.Fatalf("list: %d %s", response.Code, response.Body.String())
		}
		var body struct {
			Executions []sdk.ExecutionInfo `json:"executions"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Executions
	}
	var mainID string
	found := false
	for _, info := range inventory() {
		if info.IsMainSession {
			mainID = info.ExecutionID
			if info.StartedAt == 0 || len(info.Argv) == 0 {
				t.Fatalf("missing main metadata: %+v", info)
			}
		}
		if info.ExecutionID == execution.ID() {
			found = true
			if info.TTY || strings.Join(info.Argv, " ") != "sleep 300" {
				t.Fatalf("wrong metadata: %+v", info)
			}
		}
	}
	if !found || mainID == "" {
		t.Fatalf("missing exec/main: %+v", inventory())
	}
	response := request(http.MethodGet, base+"/"+execution.ID())
	if response.Code != http.StatusOK {
		t.Fatalf("recover status: %d %s", response.Code, response.Body.String())
	}
	response = request(http.MethodDelete, "/v1/boxes/wrong-box/executions/"+execution.ID())
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-box kill: %d", response.Code)
	}
	response = request(http.MethodDelete, base+"/"+execution.ID())
	if response.Code != http.StatusNoContent {
		t.Fatalf("recover kill: %d %s", response.Code, response.Body.String())
	}
	if _, err := execution.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	for _, info := range inventory() {
		if info.ExecutionID == execution.ID() {
			t.Fatal("killed execution remained live")
		}
	}
	wsURL := strings.Replace(server.URL, "http://", "ws://", 1) + base + "/" + mainID + "/attach"
	connection, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if deadline, ok := t.Deadline(); ok {
		_ = connection.SetReadDeadline(deadline)
	}
	_, data, err := connection.ReadMessage()
	connection.Close()
	if err != nil || !strings.Contains(string(data), "recovered-main") {
		t.Fatalf("main output not recovered: %q, %v", data, err)
	}
	if err := box.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if entries := inventory(); len(entries) != 0 {
		t.Fatalf("stopped inventory: %+v", entries)
	}
	info, err := box.Info(ctx)
	if err != nil || info.Running {
		t.Fatalf("listing started a stopped box: %+v, %v", info, err)
	}
	retained, ok := manager.Get(mainID)
	if !ok {
		t.Fatal("main execution was not retained")
	}
	<-retained.Done
	response = request(http.MethodGet, base+"/"+mainID)
	var status ExecutionInfoResponse
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || status.Status != "completed" {
		t.Fatalf("stopped main status was not retained: %d %s", response.Code, response.Body.String())
	}
	if err := box.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := runtime.Get(ctx, "e2e-api-box")
	if err != nil {
		t.Fatal(err)
	}
	box = restarted
	if err := box.Start(ctx); err != nil {
		t.Fatal(err)
	}
	response = request(http.MethodGet, base+"/"+mainID)
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || status.Status != "running" {
		t.Fatalf("restarted main was shadowed by retained status: %d %s", response.Code, response.Body.String())
	}
	connection, _, err = websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if deadline, ok := t.Deadline(); ok {
		_ = connection.SetReadDeadline(deadline)
	}
	_, data, err = connection.ReadMessage()
	if err != nil || !strings.Contains(string(data), "recovered-main") {
		t.Fatalf("restarted main output not recovered: %q, %v", data, err)
	}
	duplicate, rejection, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if duplicate != nil {
		_ = duplicate.Close()
	}
	if rejection != nil {
		defer rejection.Body.Close()
	}
	if err == nil || rejection == nil || rejection.StatusCode != http.StatusConflict {
		t.Fatalf("second output reader was not rejected: response=%v, err=%v", rejection, err)
	}
}
