// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/boxlite-ai/runner/pkg/drain"
)

func TestSetDrainAndStatus(t *testing.T) {
	drain.Disable()
	t.Cleanup(drain.Disable)

	w := runHandler(http.MethodPost,
		"/admin/drain",
		"/admin/drain",
		strings.NewReader(`{"draining":true}`),
		SetDrain)
	if w.Code != http.StatusOK {
		t.Fatalf("enable drain: expected 200, got %d body=%s", w.Code, w.Body.String())
	}

	w = runHandler(http.MethodGet, "/admin/drain", "/admin/drain", nil, DrainStatus)
	if w.Code != http.StatusOK {
		t.Fatalf("status: expected 200, got %d body=%s", w.Code, w.Body.String())
	}

	var status DrainStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatalf("unmarshal status: %v", err)
	}
	if !status.Draining {
		t.Fatalf("expected draining=true, got %+v", status)
	}
}
