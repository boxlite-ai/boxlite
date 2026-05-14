// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

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

// ProxyRequest handles toolbox/terminal requests.
// For WebSocket: bridges to an interactive TTY session via BoxLite exec.
// For HTTP GET: serves the xterm.js terminal page (loaded in an iframe by the dashboard).
func ProxyRequest(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		sandboxId := ctx.Param("sandboxId")

		if ctx.Request.Header.Get("Upgrade") == "websocket" {
			handleWebSocketTerminal(ctx, r, sandboxId, logger)
			return
		}

		ctx.Data(http.StatusOK, "text/html; charset=utf-8", []byte(terminalHTML))
	}
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

func handleWebSocketTerminal(ctx *gin.Context, r *runner.Runner, sandboxId string, logger *slog.Logger) {
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
	execution, err := r.Boxlite.StartExecution(ctx.Request.Context(), sandboxId, shellCmd, shellArgs, wsWriter, wsWriter, true)
	if err != nil {
		logger.Warn("failed to start terminal execution", "sandbox", sandboxId, "error", err)
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
