// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/gin-gonic/gin"
	"golang.org/x/net/websocket"
)

func cloudAppProxy(t *testing.T, gateway http.Handler) *Proxy {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/preview/domains/") {
			_ = json.NewEncoder(w).Encode(map[string]string{"type": "app", "environmentId": "env-demo"})
			return
		}
		gateway.ServeHTTP(w, r)
	}))
	t.Cleanup(api.Close)
	client := apiclient.NewConfiguration()
	client.Servers[0].URL = api.URL + "/api"
	client.AddDefaultHeader("Authorization", "Bearer proxy-key")
	return &Proxy{apiclient: apiclient.NewAPIClient(client), config: &config.Config{ProxyAppDomain: appDomain, ProxyProtocol: "https", ProxyApiKey: "proxy-key"}}
}

func TestCloudAppPreservesRequestAndUsesGatewayIdentity(t *testing.T) {
	p := cloudAppProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.NewEncoder(w).Encode(map[string]string{"path": r.URL.EscapedPath(), "query": r.URL.RawQuery, "host": r.Host, "method": r.Method, "body": string(body), "authorization": r.Header.Get("Authorization"), "cookie": r.Header.Get("Cookie"), "proxy": r.Header.Get("X-BoxLite-Proxy-Token"), "user": r.Header.Get("X-BoxLite-User-Id")})
	}))
	engine := gin.New()
	engine.Any("/*path", p.handleHTTP)
	server := httptest.NewServer(engine)
	defer server.Close()
	r, err := http.NewRequest(http.MethodPost, server.URL+"/api/a%2Fb?q=x%2Fy", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	r.Host = "demo." + appDomain
	r.Header.Set("Authorization", "Bearer app-key")
	r.Header.Set("Cookie", "__Host-bxl_session=end-user; application=own")
	r.Header.Set("X-BoxLite-Proxy-Token", "forged")
	r.Header.Set("X-BoxLite-User-Id", "forged-user")
	w, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Body.Close()
	var got map[string]string
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("gateway response %d: %v", w.StatusCode, err)
	}
	for key, expected := range map[string]string{"path": "/api/internal/apps/ingress/env-demo/api/a%2Fb", "query": "q=x%2Fy", "host": "demo." + appDomain, "method": "POST", "body": "payload", "authorization": "Bearer app-key", "cookie": "__Host-bxl_session=end-user; application=own", "proxy": "proxy-key", "user": ""} {
		if got[key] != expected {
			t.Errorf("%s = %q, want %q", key, got[key], expected)
		}
	}
}

func TestCloudAppWebSocketReachesGateway(t *testing.T) {
	p := cloudAppProxy(t, websocket.Handler(func(c *websocket.Conn) {
		defer c.Close()
		var message string
		if err := websocket.Message.Receive(c, &message); err == nil {
			_ = websocket.Message.Send(c, c.Request().Header.Get("Authorization")+":"+message)
		}
	}))
	engine := gin.New()
	engine.Any("/*path", p.handleHTTP)
	server := httptest.NewServer(engine)
	defer server.Close()
	cfg, err := websocket.NewConfig("ws://demo."+appDomain+"/ws", "https://demo."+appDomain)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Header.Set("Authorization", "Bearer app-session")
	raw, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	conn, err := websocket.NewClient(cfg, raw)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := websocket.Message.Send(conn, "ping"); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := websocket.Message.Receive(conn, &got); err != nil {
		t.Fatal(err)
	}
	if got != "Bearer app-session:ping" {
		t.Fatalf("gateway replied %q", got)
	}
}

func TestCloudAppRejectsRawConnect(t *testing.T) {
	p := cloudAppProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("raw CONNECT reached gateway") }))
	r := httptest.NewRequest(http.MethodConnect, "http://demo."+appDomain, nil)
	r.Host = "demo." + appDomain
	w := httptest.NewRecorder()
	p.handleTunnelConnect(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("CONNECT = %d", w.Code)
	}
}
