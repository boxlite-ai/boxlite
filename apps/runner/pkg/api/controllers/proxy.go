// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"log/slog"
	"net/http"

	"github.com/daytonaio/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ProxyRequest handles toolbox/terminal requests.
// For WebSocket: bridges to an interactive TTY session via BoxLite exec.
// For HTTP: executes a command and returns the result.
func ProxyRequest(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		sandboxId := ctx.Param("sandboxId")

		// WebSocket upgrade → interactive terminal
		if ctx.Request.Header.Get("Upgrade") == "websocket" {
			handleWebSocketTerminal(ctx, r, sandboxId, logger)
			return
		}

		// HTTP → exec command
		result, execErr := r.Boxlite.Exec(ctx.Request.Context(), sandboxId, "echo", "ok")
		if execErr != nil {
			logger.Warn("sandbox exec failed", "sandbox", sandboxId, "error", execErr)
			ctx.JSON(http.StatusBadGateway, gin.H{"error": "sandbox not reachable: " + execErr.Error()})
			return
		}

		_ = result
		ctx.JSON(http.StatusOK, gin.H{"message": "sandbox is running", "sandbox": sandboxId})
	}
}

func handleWebSocketTerminal(ctx *gin.Context, r *runner.Runner, sandboxId string, logger *slog.Logger) {
	ws, err := upgrader.Upgrade(ctx.Writer, ctx.Request, nil)
	if err != nil {
		logger.Warn("websocket upgrade failed", "error", err)
		return
	}
	defer ws.Close()

	// Create a writer that sends data to the WebSocket
	wsWriter := &wsOutputWriter{conn: ws}

	session, err := r.Boxlite.StartSession(ctx.Request.Context(), sandboxId, "/bin/sh", nil, wsWriter, wsWriter)
	if err != nil {
		logger.Warn("failed to start terminal session", "sandbox", sandboxId, "error", err)
		ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, err.Error()))
		return
	}
	defer session.Close()

	// Read from WebSocket → write to session stdin
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return
			}
			logger.Debug("websocket read error", "error", err)
			return
		}

		if err := session.Write(msg); err != nil {
			logger.Warn("session write failed", "error", err)
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
