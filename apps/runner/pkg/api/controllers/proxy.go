// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/boxlite-ai/runner/internal/constants"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/boxlite-ai/runner/pkg/shellutil"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// WebSocket keepalive tuning for handleWebSocketTerminal.
//
// AWS ALB User Guide (HTTP 408 troubleshooting) requires "at least 1 byte of
// data before each idle timeout period elapses" or the connection is silently
// RST'd. We send a WS Ping every 15 s as the application-layer heartbeat —
// real TCP bytes through the proxy chain, which both the AWS ALB and any
// intermediate hops count as activity.
//
// Mirrors the pattern in boxlite_exec_attach.go::runKeepalive (PR #505) so
// both WS handlers in this package follow the same shape.
const (
	terminalKeepaliveInterval = 15 * time.Second
	terminalWriteDeadline     = 20 * time.Second
)

// ProxyRequest handles the terminal preview endpoint. Legacy in-box toolbox
// endpoints are no longer available because boxes do not run the old daemon.
func ProxyRequest(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		boxId := ctx.Param("boxId")
		path := toolboxEscapedPath(ctx.Request, boxId, ctx.Param("path"))

		if isTerminalToolboxPath(path) {
			if strings.EqualFold(ctx.Request.Header.Get("Upgrade"), "websocket") {
				handleWebSocketTerminal(ctx, r, boxId, logger)
				return
			}

			ctx.Data(http.StatusOK, "text/html; charset=utf-8", []byte(terminalHTML))
			return
		}

		port, targetPath, ok, err := parseGuestPortProxyPath(path)
		if err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if ok {
			handleGuestPortProxy(ctx, r, boxId, port, targetPath, logger)
			return
		}

		legacyToolboxUnavailable(ctx, logger, boxId, path)
	}
}

// BoxliteNetworkProxy exposes an in-box HTTP service through the BoxLite REST API namespace.
func BoxliteNetworkProxy(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		boxId := ctx.Param("boxId")
		rawPort := ctx.Param("port")
		port64, err := strconv.ParseUint(rawPort, 10, 16)
		if err != nil || port64 == 0 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid target port %q", rawPort)})
			return
		}

		targetPath := networkProxyEscapedPath(ctx.Request, boxId, rawPort, ctx.Param("path"))
		handleGuestPortProxy(ctx, r, boxId, uint16(port64), targetPath, logger)
	}
}

// BoxliteNetworkTunnel upgrades an authenticated CONNECT request to a raw guest stream.
func BoxliteNetworkTunnel(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		if ctx.Request.Method != http.MethodConnect {
			ctx.JSON(http.StatusMethodNotAllowed, gin.H{"error": "CONNECT required"})
			return
		}
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		boxId := ctx.Param("boxId")
		rawPort := ctx.Query("port")
		port64, err := strconv.ParseUint(rawPort, 10, 16)
		if err != nil || port64 == 0 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid target port %q", rawPort)})
			return
		}

		guestConn, err := r.Boxlite.DialGuestPort(ctx.Request.Context(), boxId, uint16(port64))
		if err != nil {
			logger.WarnContext(ctx.Request.Context(), "guest tunnel dial failed", "box", boxId, "port", port64, "error", err)
			ctx.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}

		hijacker, ok := ctx.Writer.(http.Hijacker)
		if !ok {
			guestConn.Close()
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": "connection hijacking unavailable"})
			return
		}
		clientConn, buffered, err := hijacker.Hijack()
		if err != nil {
			guestConn.Close()
			return
		}
		defer clientConn.Close()
		defer guestConn.Close()
		if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
		if err := buffered.Flush(); err != nil {
			return
		}
		common_proxy.ProxyBidirectionalStream(clientConn, guestConn)
	}
}

func normalizeToolboxPath(path string) string {
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		return "/" + path
	}
	return path
}

func toolboxEscapedPath(req *http.Request, boxId string, fallbackPath string) string {
	if req != nil && req.URL != nil {
		prefix := "/boxes/" + url.PathEscape(boxId) + "/toolbox"
		if path := req.URL.EscapedPath(); strings.HasPrefix(path, prefix) {
			return normalizeToolboxPath(strings.TrimPrefix(path, prefix))
		}
	}
	return normalizeToolboxPath(fallbackPath)
}

func networkProxyEscapedPath(req *http.Request, boxId string, port string, fallbackPath string) string {
	if req != nil && req.URL != nil {
		prefix := "/v1/boxes/" + url.PathEscape(boxId) + "/network/proxy/" + url.PathEscape(port)
		if path := req.URL.EscapedPath(); strings.HasPrefix(path, prefix) {
			return normalizeToolboxPath(strings.TrimPrefix(path, prefix))
		}
	}
	return normalizeToolboxPath(fallbackPath)
}

func isTerminalToolboxPath(path string) bool {
	path = normalizeToolboxPath(path)
	return path == "/" || path == "/proxy/22222" || strings.HasPrefix(path, "/proxy/22222/")
}

func parseGuestPortProxyPath(path string) (uint16, string, bool, error) {
	path = normalizeToolboxPath(path)
	if !strings.HasPrefix(path, "/proxy/") {
		return 0, "", false, nil
	}

	rest := strings.TrimPrefix(path, "/proxy/")
	rawPort, targetPath, _ := strings.Cut(rest, "/")
	if rawPort == "" {
		return 0, "", true, fmt.Errorf("target port is required")
	}
	port, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil {
		return 0, "", true, fmt.Errorf("invalid target port %q", rawPort)
	}
	if port == 0 {
		return 0, "", true, fmt.Errorf("target port must be in range 1-65535")
	}
	if targetPath == "" {
		targetPath = "/"
	} else {
		targetPath = "/" + targetPath
	}
	return uint16(port), targetPath, true, nil
}

func setEscapedURLPath(target *url.URL, escapedPath string) {
	parsed, err := url.Parse("http://boxlite.invalid" + normalizeToolboxPath(escapedPath))
	if err != nil {
		target.Path = normalizeToolboxPath(escapedPath)
		target.RawPath = ""
		return
	}
	target.Path = parsed.Path
	target.RawPath = parsed.RawPath
}

func handleGuestPortProxy(ctx *gin.Context, r *runner.Runner, boxId string, port uint16, targetPath string, logger *slog.Logger) {
	forwarded := common_proxy.ForwardedRequestInfoFromHeaders(ctx.Request.Header)
	target := &url.URL{
		Scheme: "http",
		Host:   net.JoinHostPort(sdk.GuestIP, strconv.Itoa(int(port))),
	}
	setEscapedURLPath(target, targetPath)
	transport := r.Boxlite.GuestPortTransport(boxId, port, logger)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(req *httputil.ProxyRequest) {
			configureGuestPortProxyRequest(req.Out, target, forwarded)
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
			logger.WarnContext(req.Context(), "guest port proxy failed", "box", boxId, "port", port, "error", err)
			http.Error(w, guestPortProxyErrorMessage(port, err), http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(ctx.Writer, ctx.Request)
}

func guestPortProxyErrorMessage(port uint16, err error) string {
	message := "guest port proxy failed"
	if err != nil {
		message = err.Error()
	}
	lower := strings.ToLower(message)
	if strings.Contains(lower, "connection reset by peer") ||
		strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "broken pipe") ||
		lower == "eof" {
		return fmt.Sprintf("guest service on port %d is not accepting connections", port)
	}
	return "guest port proxy failed"
}

func configureGuestPortProxyRequest(req *http.Request, target *url.URL, forwarded common_proxy.ForwardedRequestInfo) {
	externalHost := target.Host
	if forwarded.Host != "" {
		externalHost = forwarded.Host
	}
	req.Host = externalHost
	req.URL.Scheme = target.Scheme
	req.URL.Host = target.Host
	req.URL.Path = target.Path
	req.URL.RawPath = target.RawPath
	req.Header.Del(constants.BOXLITE_AUTHORIZATION_HEADER)

	common_proxy.ApplyTrustedForwardedHeaders(req.Header, forwarded)
}

func legacyToolboxUnavailable(ctx *gin.Context, logger *slog.Logger, boxId string, path string) {
	logger.InfoContext(ctx.Request.Context(), "legacy toolbox proxy request rejected", "box", boxId, "path", path)
	ctx.JSON(http.StatusGone, gin.H{
		"error": "legacy toolbox proxy is no longer available; use the BoxLite REST API or terminal preview",
	})
}

const terminalHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<style>
html,body{margin:0;padding:0;height:100%;background:#1e1e1e;overflow:hidden}
#terminal{height:100%;width:100%}
</style>
</head>
<body>
<div id="terminal"></div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
var term=new Terminal({cursorBlink:true,theme:{background:'#1e1e1e'}});
var fitAddon=new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

var proto=location.protocol==='https:'?'wss:':'ws:';
var ws=new WebSocket(proto+'//'+location.host+location.pathname+location.search);
ws.onopen=function(){term.focus();};
ws.onmessage=function(e){term.write(e.data);};
ws.onclose=function(){term.write('\r\n[Connection closed]\r\n');};
ws.onerror=function(){term.write('\r\n[Connection error]\r\n');};
term.onData(function(data){if(ws.readyState===WebSocket.OPEN)ws.send(data);});
window.addEventListener('resize',function(){fitAddon.fit();});
</script>
</body>
</html>`

func handleWebSocketTerminal(ctx *gin.Context, r *runner.Runner, boxId string, logger *slog.Logger) {
	ws, err := upgrader.Upgrade(ctx.Writer, ctx.Request, nil)
	if err != nil {
		logger.Warn("websocket upgrade failed", "error", err)
		return
	}
	defer ws.Close()

	// Serialize all writes to the WS conn. gorilla/websocket panics on
	// concurrent writers; the stdout writer and the keepalive goroutine
	// both write and must share this mutex.
	var writeMu sync.Mutex
	wsWriter := &wsOutputWriter{conn: ws, mu: &writeMu}

	// Bound the keepalive goroutine to the request lifetime; cancel it when
	// the terminal handler returns so the ticker doesn't leak.
	keepaliveCtx, cancelKeepalive := context.WithCancel(ctx.Request.Context())
	defer cancelKeepalive()
	go runTerminalKeepalive(keepaliveCtx, ws, &writeMu, logger)

	shellCmd, shellArgs := shellutil.DefaultInteractiveShell()
	execution, err := r.Boxlite.StartExecution(ctx.Request.Context(), boxId, shellCmd, shellArgs, wsWriter, wsWriter, true)
	if err != nil {
		logger.Warn("failed to start terminal execution", "box", boxId, "error", err)
		writeMu.Lock()
		_ = ws.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, err.Error()),
			time.Now().Add(terminalWriteDeadline),
		)
		writeMu.Unlock()
		return
	}
	defer execution.Close()

	// Read from WebSocket and write to execution stdin.
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return
			}
			logger.Debug("websocket read error", "error", err)
			return
		}

		if _, err := execution.Stdin.Write(msg); err != nil {
			logger.Warn("execution stdin write failed", "error", err)
			return
		}
	}
}

// runTerminalKeepalive sends a WebSocket Ping every terminalKeepaliveInterval
// to keep the connection alive through any intermediate hop with an idle
// timer. Mirrors apps/runner/pkg/api/controllers/boxlite_exec_attach.go's
// runKeepalive — see that file's commentary on AWS ALB HTTP 408 troubleshooting.
//
// Exits cleanly when ctx is cancelled or when a ping write fails.
func runTerminalKeepalive(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, logger *slog.Logger) {
	ticker := time.NewTicker(terminalKeepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			writeMu.Lock()
			deadline := time.Now().Add(terminalWriteDeadline)
			err := conn.WriteControl(websocket.PingMessage, nil, deadline)
			writeMu.Unlock()
			if err != nil {
				if ctx.Err() == nil {
					logger.Debug("terminal keepalive ping failed", "error", err)
				}
				return
			}
		}
	}
}

// wsOutputWriter implements io.Writer by sending text messages over WebSocket.
// All writes are serialized through `mu` because gorilla/websocket forbids
// concurrent writers and the keepalive goroutine writes Pings on the same conn.
type wsOutputWriter struct {
	conn *websocket.Conn
	mu   *sync.Mutex
}

func (w *wsOutputWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.conn.SetWriteDeadline(time.Now().Add(terminalWriteDeadline)); err != nil {
		return 0, err
	}
	if err := w.conn.WriteMessage(websocket.TextMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}
