// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/gin-gonic/gin"
)

func TestPrivateTunnelHTTPAndUpgradeIsolatePlatformCookies(t *testing.T) {
	for _, upgrade := range []bool{false, true} {
		t.Run(fmt.Sprintf("upgrade=%t", upgrade), func(t *testing.T) {
			p, _ := privateAuthProxy(t)
			guestHeaders := make(chan http.Header, 1)
			guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				guestHeaders <- r.Header.Clone()
				w.Header().Add("Set-Cookie", tunnelSessionCookie+"=guest-forgery; Secure; Path=/")
				w.Header().Add("Set-Cookie", "boxlite-box-auth-OtherBox1234=forgery; Domain=.proxy.test; Path=/")
				w.Header().Add("Set-Cookie", "app_session=guest-cookie; Path=/")
				w.Header().Set("Cache-Control", "public, max-age=600")
				w.Header().Set("Referrer-Policy", "unsafe-url")
				if r.URL.RawQuery != "app=1" {
					t.Errorf("guest query = %q", r.URL.RawQuery)
				}
				if upgrade {
					conn, rw, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					defer conn.Close()
					_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n")
					_ = w.Header().Write(rw)
					_, _ = rw.WriteString("\r\n")
					_ = rw.Flush()
					_, _ = io.Copy(conn, rw)
					return
				}
				_, _ = w.Write([]byte("app-response"))
			}))
			defer guest.Close()
			p.guestPortTransport = &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, guest.Listener.Addr().String())
			}}
			defer p.guestPortTransport.CloseIdleConnections()
			router := gin.New()
			router.Any("/*path", func(ctx *gin.Context) {
				defer stopActivityPoll(ctx)
				common_proxy.NewProxyRequestHandler(p.GetProxyTarget, nil)(ctx)
			})
			proxy := httptest.NewServer(sanitizeTunnelRequests(router))
			defer proxy.Close()
			conn, err := net.Dial("tcp", proxy.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
			upgradeHeaders := ""
			if upgrade {
				upgradeHeaders = "Connection: Upgrade\r\nUpgrade: websocket\r\nOrigin: https://3000-d-416243644566313233343536.proxy.test\r\n"
			}
			_, _ = fmt.Fprintf(conn, "GET /?%s=%s&app=1 HTTP/1.1\r\nHost: 3000-d-416243644566313233343536.proxy.test\r\nCookie: app_session=original; boxlite-box-auth-OtherBox1234=other-box-secret; pkce_verifier=secret\r\nAuthorization: Bearer app-key\r\n%s\r\n", accessTokenQuery, privateTestToken, upgradeHeaders)
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			wantStatus := http.StatusOK
			if upgrade {
				wantStatus = http.StatusSwitchingProtocols
			}
			if response.StatusCode != wantStatus {
				t.Fatalf("response = %d", response.StatusCode)
			}
			cookies := response.Cookies()
			if len(cookies) != 2 {
				t.Fatalf("response cookies = %v", cookies)
			}
			for _, cookie := range cookies {
				if strings.Contains(cookie.Value, "forgery") {
					t.Fatal("guest overwrote platform cookie")
				}
			}
			if response.Header.Get("Cache-Control") != "private, no-store" || response.Header.Get("Referrer-Policy") != "no-referrer" {
				t.Fatal("guest weakened private response policy")
			}
			headers := <-guestHeaders
			if headers.Get("Cookie") != "app_session=original" || headers.Get("Authorization") != "Bearer app-key" {
				t.Fatalf("guest credentials = %v", headers)
			}
			if upgrade {
				_, _ = conn.Write([]byte("ping"))
				payload := make([]byte, 4)
				if _, err := io.ReadFull(reader, payload); err != nil || string(payload) != "ping" {
					t.Fatalf("upgrade stream: %q %v", payload, err)
				}
			}
		})
	}
}
