//go:build boxlite_dev && boxlite_integration

package controllers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// Start outside ExecManager, then recover the real guest IDs through HTTP.
// This is the same ownership gap a client/server restart creates.
func TestExecutionInventoryRecoveryHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	runtime, err := sdk.NewRuntime(sdk.WithHomeDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	box, err := runtime.Create(ctx, "docker.m.daocloud.io/library/alpine:latest",
		sdk.WithAutoRemove(false), sdk.WithCmd("sh", "-c", "while true; do echo recovered-main; sleep 0.1; done"))
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	defer runtime.ForceRemove(context.Background(), box.ID())
	if err := box.Start(ctx); err != nil {
		t.Fatal(err)
	}
	execution, err := box.StartExecution(ctx, "sleep", []string{"300"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer execution.Close()

	manager := withFreshExecManager(t)
	defer manager.Stop()
	previous := getExecutionBox
	getExecutionBox = func(_ *gin.Context, id string) (*sdk.Box, error) {
		if id != box.ID() {
			return nil, &sdk.Error{Code: sdk.ErrNotFound, Message: "box not found"}
		}
		return box, nil
	}
	defer func() { getExecutionBox = previous }()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/v1/boxes/:boxId/executions", BoxliteListExecutions)
	router.GET("/v1/boxes/:boxId/executions/:execId", BoxliteGetExecution)
	router.GET("/v1/boxes/:boxId/executions/:execId/attach", BoxliteExecAttach)
	router.DELETE("/v1/boxes/:boxId/executions/:execId", BoxliteExecKill)
	server := httptest.NewServer(router)
	defer server.Close()
	base := "/v1/boxes/" + box.ID() + "/executions"
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
		if info.IsMain {
			mainID = info.ExecutionID
		}
		if info.ExecutionID == execution.ID() {
			found = true
			if info.PID == 0 || info.TTY || strings.Join(info.Argv, " ") != "sleep 300" {
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
	connection.SetReadDeadline(time.Now().Add(10 * time.Second))
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
}
