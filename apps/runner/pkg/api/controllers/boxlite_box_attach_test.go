// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// withStubMainSession installs target as the main session boxId opens, for
// the duration of the test.
func withStubMainSession(t *testing.T, boxId, execId string, target attachExec) {
	t.Helper()
	prev := openMainSession
	openMainSession = func(ctx context.Context, id string) (attachExec, string, error) {
		if id == boxId {
			return target, execId, nil
		}
		return prev(ctx, id)
	}
	t.Cleanup(func() { openMainSession = prev })
}

// newBoxAttachServer routes the box-level attach path to BoxliteBoxAttach.
// The path mirrors production registration in pkg/api/server.go, which
// TestBoxAttachRouteIsRegistered holds to.
func newBoxAttachServer(t *testing.T) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/boxes/:boxId/attach", BoxliteBoxAttach)
	return httptest.NewServer(r)
}

func dialBoxAttach(t *testing.T, srv *httptest.Server, boxId string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/v1/boxes/" + boxId + "/attach"
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 5 * time.Second
	return dialer.Dial(wsURL, nil)
}

// TestBoxliteBoxAttach_UpgradeCarriesMainSessionID pins the half of the
// contract the client cannot work around: the main session's execution id
// rides back on the 101.
//
// The client has no fallback for a missing header — RestBox::attach in
// src/boxlite/src/rest/litebox.rs fails the attach outright — because every
// other thing it does with the session (signal, resize, kill, reattach) is
// addressed by execution id, and it has no other way to learn one.
func TestBoxliteBoxAttach_UpgradeCarriesMainSessionID(t *testing.T) {
	stub := newStubAttachExec()
	withStubMainSession(t, "box-1", "main-session-7", stub)

	srv := newBoxAttachServer(t)
	defer srv.Close()

	conn, resp, err := dialBoxAttach(t, srv, "box-1")
	if err != nil {
		t.Fatalf("dial box attach: %v (resp=%v)", err, resp)
	}
	defer conn.Close()

	if got := resp.Header.Get("X-Boxlite-Execution-Id"); got != "main-session-7" {
		t.Fatalf("expected the main session id on the upgrade, got %q (headers=%v)", got, resp.Header)
	}
}

// TestBoxliteBoxAttach_SecondClientIsRefused: the main session has a single
// attach slot like any other session, and the refusal has to land as an HTTP
// status rather than a closed socket — so it is claimed before the upgrade.
func TestBoxliteBoxAttach_SecondClientIsRefused(t *testing.T) {
	stub := newStubAttachExec()
	withStubMainSession(t, "box-1", "main-session-7", stub)

	srv := newBoxAttachServer(t)
	defer srv.Close()

	first, _, err := dialBoxAttach(t, srv, "box-1")
	if err != nil {
		t.Fatalf("first attach: %v", err)
	}
	defer first.Close()

	second, resp, err := dialBoxAttach(t, srv, "box-1")
	if err == nil {
		second.Close()
		t.Fatal("expected the second attach to be refused")
	}
	if resp == nil || resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected HTTP 409, got %v", resp)
	}
}

// TestBoxliteBoxAttach_OpenFailureIsNotAnUpgrade: when the session cannot be
// opened the client must get a status it can read, not a dropped connection.
func TestBoxliteBoxAttach_OpenFailureIsNotAnUpgrade(t *testing.T) {
	prev := openMainSession
	openMainSession = func(_ context.Context, boxId string) (attachExec, string, error) {
		return nil, "", errBoxNotFound
	}
	t.Cleanup(func() { openMainSession = prev })

	srv := newBoxAttachServer(t)
	defer srv.Close()

	conn, resp, err := dialBoxAttach(t, srv, "box-missing")
	if err == nil {
		conn.Close()
		t.Fatal("expected the attach to be refused")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected HTTP 404, got %v", resp)
	}
}
