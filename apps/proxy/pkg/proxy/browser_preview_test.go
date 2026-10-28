// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/gin-gonic/gin"
	"golang.org/x/net/websocket"
)

// This checks the E2E driver against real proxy middleware and Chromium, with
// local API/guest fixtures. It does not create a VM or count as cloud E2E.
func TestBrowserPreviewWarning(t *testing.T) {
	if os.Getenv("BOXLITE_E2E_BROWSER_EXECUTABLE") == "" {
		t.Skip("set BOXLITE_E2E_BROWSER_EXECUTABLE to run the Chromium regression")
	}
	driver, err := filepath.Abs("../../../e2e/sdks/node/preview-browser.mjs")
	if err != nil {
		t.Fatal(err)
	}
	for _, warning := range []bool{false, true} {
		t.Run(fmt.Sprintf("enabled=%t", warning), func(t *testing.T) {
			const marker = "browser-warning-guest"
			guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/browser":
					w.Header().Set("Content-Type", "text/html")
					fmt.Fprint(w, "<!doctype html><script src='/asset.js'></script>")
				case "/asset.js":
					w.Header().Set("Content-Type", "application/javascript")
					fmt.Fprintf(w, "window.fixtureAsset = %q;", marker)
				case "/inspect":
					headers := make(map[string]string)
					for key := range r.Header {
						headers[key] = r.Header.Get(key)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{
						"marker": marker, "path": r.URL.RequestURI(), "headers": headers,
					})
				case "/ws":
					websocket.Handler(func(conn *websocket.Conn) {
						defer conn.Close()
						var message string
						if err := websocket.Message.Receive(conn, &message); err == nil {
							_ = websocket.Message.Send(conn, marker+":"+message)
						}
					}).ServeHTTP(w, r)
				default:
					http.NotFound(w, r)
				}
			}))
			defer guest.Close()
			p, _ := privateAuthProxy(t)
			p.guestPortTransport = &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, guest.Listener.Addr().String())
			}}
			defer p.guestPortTransport.CloseIdleConnections()
			var acceptances atomic.Int32
			router := gin.New()
			if warning {
				router.Use(p.browserWarningMiddleware())
			}
			router.Any("/*path", func(ctx *gin.Context) {
				if ctx.Request.Method == http.MethodPost && ctx.Request.URL.Path == ACCEPT_PREVIEW_PAGE_WARNING_PATH {
					acceptances.Add(1)
					if ctx.Request.URL.RawQuery != "" || !strings.Contains(ctx.PostForm("redirect"), privateTestToken) {
						t.Error("warning acceptance must carry the token return URL in its POST body")
					}
					handleAcceptProxyWarning(ctx, true)
					return
				}
				defer stopActivityPoll(ctx)
				common_proxy.NewProxyRequestHandler(p.GetProxyTarget, nil)(ctx)
			})
			server := httptest.NewTLSServer(sanitizeTunnelRequests(router))
			defer server.Close()
			_, port, err := net.SplitHostPort(server.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			input, err := json.Marshal(map[string]string{
				"uri":   "https://3000-d-416243644566313233343536.localhost:" + port,
				"token": privateTestToken, "marker": marker,
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "node", driver)
			command.Env = append(os.Environ(), "BOXLITE_E2E_BROWSER_LOCAL_CA=1")
			command.Stdin = bytes.NewReader(input)
			output, err := command.CombinedOutput()
			if err != nil || !bytes.Contains(output, []byte("PREVIEW_BROWSER=ok")) {
				t.Fatalf("browser preview failed: %v\n%s", err, bytes.ReplaceAll(output, []byte(privateTestToken), []byte("[redacted]")))
			}
			wantAcceptances := int32(0)
			if warning {
				wantAcceptances = 1
			}
			if got := acceptances.Load(); got != wantAcceptances {
				t.Errorf("warning acceptance count = %d, want %d", got, wantAcceptances)
			}
		})
	}
}
