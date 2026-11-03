// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"context"
	"encoding/json"
	commonerrors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/runner/pkg/common"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/middlewares"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/gin-gonic/gin"
)

func TestCheckpointTransferHTTPPreservesInputAndStorageEnvelopes(t *testing.T) {
	home := t.TempDir()
	client, e := blclient.NewClient(context.Background(), blclient.ClientConfig{HomeDir: home})
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	router := gin.New()
	router.Use(commonerrors.NewErrorMiddleware(common.HandlePossibleDockerError))
	group := router.Group("/api/checkpoint-transfers")
	group.Use(middlewares.AuthMiddleware("internal-test-key"))
	handler := CheckpointTransferHandler(client.Checkpoints())
	group.POST("/:transferId", handler)
	group.POST("/:transferId/register", handler)
	group.POST("/:transferId/export", handler)
	group.DELETE("/:transferId", handler)
	for _, tc := range []struct {
		name, method, target, body, token string
		want                              int
		code                              string
	}{
		{"auth", http.MethodPost, "/bad", "", "", 401, ""},
		{"invalid UUID", http.MethodDelete, "/bad", "", "internal-test-key", 400, "invalid_argument"},
		{"unknown request field", http.MethodPost, "/11111111-1111-4111-8111-111111111111/register", `{"organizationId":"org","hostPath":"/etc/passwd"}`, "internal-test-key", 400, "invalid_argument"},
		{"invalid content type", http.MethodPost, "/11111111-1111-4111-8111-111111111111", "bytes", "internal-test-key", 400, "invalid_argument"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, "/api/checkpoint-transfers"+tc.target, strings.NewReader(tc.body))
			if tc.token != "" {
				request.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			if tc.code != "" {
				var payload struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if e := json.Unmarshal(response.Body.Bytes(), &payload); e != nil || payload.Error.Code != tc.code {
					t.Fatalf("envelope=%s err=%v", response.Body, e)
				}
			}
		})
	}
	// A real filesystem failure is kept as Storage/500 by the same handler,
	// instead of guessing that every failure during upload is a bad request.
	root := filepath.Join(home, "checkpoint-work")
	if e = os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(root, "transfer-records"), []byte("not a directory"), 0600); e != nil {
		t.Fatal(e)
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/checkpoint-transfers/11111111-1111-4111-8111-111111111111", nil)
	request.Header.Set("Authorization", "Bearer internal-test-key")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 500 || !strings.Contains(response.Body.String(), `"code":"storage_error"`) {
		t.Fatalf("storage envelope=%d %s", response.Code, response.Body)
	}
}
