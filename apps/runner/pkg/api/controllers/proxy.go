// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"log/slog"
	"net/http"

	"github.com/boxlite-labs/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

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

	// Create a writer that sends data to the WebSocket
	wsWriter := &wsOutputWriter{conn: ws}

	execution, err := r.Boxlite.StartExecution(ctx.Request.Context(), sandboxId, "/bin/sh", nil, wsWriter, wsWriter, true)
	if err != nil {
		logger.Warn("failed to start terminal execution", "sandbox", sandboxId, "error", err)
		ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, err.Error()))
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

// wsOutputWriter implements io.Writer by sending text messages over WebSocket
type wsOutputWriter struct {
	conn *websocket.Conn
}

func (w *wsOutputWriter) Write(p []byte) (int, error) {
	err := w.conn.WriteMessage(websocket.TextMessage, p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}
