// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/gin-gonic/gin"
)

const endpointHost = "app-fleet.proxy.example.com"
const endpointBoxID = "AbCdEf123456"

func newEndpointTestProxy(t *testing.T, handler http.Handler) *Proxy {
	t.Helper()
	api := httptest.NewServer(handler)
	t.Cleanup(api.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = api.URL
	clientConfig.AddDefaultHeader("Authorization", "Bearer proxy-key")
	p := &Proxy{
		config:                     &config.Config{BoxliteApiUrl: api.URL, ProxyApiKey: "proxy-key", ProxyProtocol: "https"},
		apiclient:                  apiclient.NewAPIClient(clientConfig),
		boxPublicCache:             common_cache.NewMapCache[bool](ctx),
		boxRunnerCache:             common_cache.NewMapCache[RunnerInfo](ctx),
		boxAuthKeyValidCache:       common_cache.NewMapCache[bool](ctx),
		boxLastActivityUpdateCache: common_cache.NewMapCache[bool](ctx),
	}
	p.guestPortTransport = p.newGuestPortTransport()
	t.Cleanup(p.guestPortTransport.CloseIdleConnections)
	if err := p.boxLastActivityUpdateCache.Set(ctx, endpointBoxID, true, time.Minute); err != nil {
		t.Fatal(err)
	}
	return p
}

func endpointResponse(w http.ResponseWriter, port int) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(boxEndpoint{BoxID: endpointBoxID, Port: port, URL: "https://" + endpointHost})
}

func TestEndpointRebindAndRevocationApplyToNextRequest(t *testing.T) {
	var port atomic.Int32
	port.Store(8080)
	p := newEndpointTestProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/box-endpoints/resolve/fleet" || r.Header.Get("Authorization") != "Bearer proxy-key" {
			t.Errorf("unexpected endpoint lookup: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		if port.Load() == 0 {
			http.NotFound(w, r)
			return
		}
		endpointResponse(w, int(port.Load()))
	}))
	handler := p.withBoxEndpoint(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		boxID, targetPort, err := p.tunnelTarget(r)
		if err != nil || boxID != endpointBoxID {
			t.Errorf("target = %s, %v", boxID, err)
		}
		fmt.Fprintf(w, "%d", targetPort)
	}))
	for _, expected := range []int{8080, 3000, 0} {
		port.Store(int32(expected))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", "https://"+endpointHost+"/", nil))
		if expected == 0 {
			if recorder.Code != 404 {
				t.Fatalf("revoked endpoint returned %d", recorder.Code)
			}
		} else if recorder.Code != 200 || recorder.Body.String() != fmt.Sprint(expected) {
			t.Fatalf("rebound endpoint returned %d %s", recorder.Code, recorder.Body.String())
		}
	}
}

func TestEndpointChecksAssignedHostAndResponse(t *testing.T) {
	for _, tc := range []struct {
		name, host, body string
		status           int
	}{
		{"case and default port", "APP-FLEET.PROXY.EXAMPLE.COM:443", `{"boxId":"AbCdEf123456","port":8080,"url":"https://app-fleet.proxy.example.com"}`, 200},
		{"wrong domain", "app-fleet.attacker.example", `{"boxId":"AbCdEf123456","port":8080,"url":"https://app-fleet.proxy.example.com"}`, 404},
		{"wrong port", endpointHost + ":8443", `{"boxId":"AbCdEf123456","port":8080,"url":"https://app-fleet.proxy.example.com"}`, 404},
		{"terminal", endpointHost, `{"boxId":"AbCdEf123456","port":22222,"url":"https://app-fleet.proxy.example.com"}`, 502},
		{"zero port", endpointHost, `{"boxId":"AbCdEf123456","port":0,"url":"https://app-fleet.proxy.example.com"}`, 502},
		{"large port", endpointHost, `{"boxId":"AbCdEf123456","port":65536,"url":"https://app-fleet.proxy.example.com"}`, 502},
		{"invalid box", endpointHost, `{"boxId":"../../secret","port":80,"url":"https://app-fleet.proxy.example.com"}`, 502},
		{"invalid JSON", endpointHost, `{`, 502},
		{"invalid URL", endpointHost, `{"boxId":"AbCdEf123456","port":80,"url":"file:///secret"}`, 502},
		{"invalid name", "app-ab.proxy.example.com", `{}`, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := newEndpointTestProxy(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, tc.body) }))
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest("GET", "https://"+tc.host+"/", nil)
			p.withBoxEndpoint(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })).ServeHTTP(recorder, request)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.status)
			}
		})
	}
}

func TestEndpointLookupDoesNotFollowRedirects(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer target.Close()
	p := newEndpointTestProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	_, status := p.resolveBoxEndpoint(context.Background(), "fleet", endpointHost)
	if status != 502 || leaked.Load() {
		t.Fatalf("redirect status = %d, followed = %v", status, leaked.Load())
	}
}

func TestEndpointLookupHonorsCancellation(t *testing.T) {
	p := newEndpointTestProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, status := p.resolveBoxEndpoint(ctx, "fleet", endpointHost)
	if status != 502 {
		t.Fatalf("status = %d", status)
	}
}

func TestEndpointLegacyHostsSkipLookup(t *testing.T) {
	p := newEndpointTestProxy(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("legacy host looked up") }))
	recorder := httptest.NewRecorder()
	p.withBoxEndpoint(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		port, boxID, _, err := p.parseRequestHost(r)
		if port != "8080" || boxID != endpointBoxID || err != nil {
			t.Errorf("legacy target = %s %s %v", port, boxID, err)
		}
	})).ServeHTTP(recorder, httptest.NewRequest("GET", "http://8080-"+endpointBoxID+".proxy.example.com/", nil))
}

func TestEndpointHTTPAndWebSocketThroughRunnerTunnel(t *testing.T) {
	for _, websocket := range []bool{false, true} {
		t.Run(fmt.Sprintf("websocket=%v", websocket), func(t *testing.T) {
			var authorized atomic.Bool
			p := newEndpointTestProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/box-endpoints/resolve/fleet":
					endpointResponse(w, 8080)
				case "/preview/" + endpointBoxID + "/public":
					http.NotFound(w, r)
				case "/preview/" + endpointBoxID + "/access":
					if r.Header.Get("Authorization") != "Bearer user-key" {
						http.NotFound(w, r)
						return
					}
					authorized.Store(true)
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, "true")
				default:
					http.NotFound(w, r)
				}
			}))
			runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "CONNECT" || r.URL.RequestURI() != "/v1/boxes/"+endpointBoxID+"/network/tunnel?port=8080" || r.Header.Get("X-BoxLite-Authorization") != "Bearer runner-key" {
					t.Errorf("invalid runner CONNECT: %s %s", r.Method, r.URL.RequestURI())
					w.WriteHeader(400)
					return
				}
				conn, readerWriter, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
				guest, err := http.ReadRequest(readerWriter.Reader)
				if err != nil {
					t.Error(err)
					return
				}
				if !authorized.Load() || guest.Host != endpointHost || guest.URL.RequestURI() != "/hello/a%2Fb?x=1" || guest.Header.Get("X-Forwarded-Host") != endpointHost {
					t.Errorf("unexpected guest request: %s %s", guest.Host, guest.URL.RequestURI())
					return
				}
				if !websocket {
					io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
					return
				}
				io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n")
				frame := make([]byte, 8)
				if _, err := io.ReadFull(readerWriter.Reader, frame); err != nil {
					t.Error(err)
					return
				}
				if !bytes.Equal(frame, []byte{0x81, 0x82, 1, 2, 3, 4, 'h' ^ 1, 'i' ^ 2}) {
					t.Errorf("bad WebSocket frame %v", frame)
					return
				}
				conn.Write([]byte{0x81, 2, 'o', 'k'})
			}))
			defer runner.Close()
			if err := p.boxRunnerCache.Set(context.Background(), endpointBoxID, RunnerInfo{ApiUrl: runner.URL, ApiKey: "runner-key"}, time.Minute); err != nil {
				t.Fatal(err)
			}
			router := gin.New()
			router.Any("/*path", func(ctx *gin.Context) {
				defer stopActivityPoll(ctx)
				common_proxy.NewProxyRequestHandler(p.GetProxyTarget, nil)(ctx)
			})
			server := httptest.NewServer(p.withBoxEndpoint(router))
			defer server.Close()
			conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), 3*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(5 * time.Second))
			upgrade := ""
			if websocket {
				upgrade = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
			}
			fmt.Fprintf(conn, "GET /hello/a%%2Fb?x=1 HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer user-key\r\n%s\r\n", endpointHost, upgrade)
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if !websocket {
				body, err := io.ReadAll(response.Body)
				if err != nil || response.StatusCode != 200 || string(body) != "ok" {
					t.Fatalf("HTTP response = %d %q %v", response.StatusCode, body, err)
				}
				return
			}
			if response.StatusCode != 101 {
				t.Fatalf("WebSocket response = %d", response.StatusCode)
			}
			conn.Write([]byte{0x81, 0x82, 1, 2, 3, 4, 'h' ^ 1, 'i' ^ 2})
			frame := make([]byte, 4)
			if _, err := io.ReadFull(reader, frame); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(frame, []byte{0x81, 2, 'o', 'k'}) {
				t.Fatalf("WebSocket response frame = %v", frame)
			}
		})
	}
}

func TestEndpointConnectKeepsPrivateBoxesPrivate(t *testing.T) {
	p := newEndpointTestProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { endpointResponse(w, 8080) }))
	if err := p.boxPublicCache.Set(context.Background(), endpointBoxID, false, time.Minute); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("CONNECT", "http://proxy.test", nil)
	request.Host = endpointHost + ":443"
	p.withBoxEndpoint(http.HandlerFunc(p.handleTunnelConnect)).ServeHTTP(recorder, request)
	if recorder.Code != 403 {
		t.Fatalf("private CONNECT status = %d", recorder.Code)
	}
}
