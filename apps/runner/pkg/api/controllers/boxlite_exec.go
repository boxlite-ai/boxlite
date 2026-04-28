package controllers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/daytonaio/runner/pkg/boxlite"
	"github.com/daytonaio/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

var execManager = boxlite.NewExecManager()

type ExecRequest struct {
	Command        string            `json:"command"`
	Args           []string          `json:"args"`
	Env            map[string]string `json:"env"`
	TimeoutSeconds *float64          `json:"timeout_seconds"`
	WorkingDir     *string           `json:"working_dir"`
	TTY            bool              `json:"tty"`
}

type ExecResponse struct {
	ExecutionID string `json:"execution_id"`
}

type SignalRequest struct {
	Signal int `json:"signal"`
}

type ResizeRequest struct {
	Cols uint32 `json:"cols"`
	Rows uint32 `json:"rows"`
}

func BoxliteExec(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	boxId := ctx.Param("boxId")

	var req ExecRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request: %s", err)})
		return
	}

	bx, err := r.Boxlite.GetBox(ctx.Request.Context(), boxId)
	if err != nil {
		ctx.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("box not found: %s", err)})
		return
	}

	execId, err := execManager.Start(ctx.Request.Context(), bx, req.Command, req.Args, req.TTY)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("exec failed: %s", err)})
		return
	}

	ctx.JSON(http.StatusCreated, ExecResponse{ExecutionID: execId})
}

func BoxliteExecOutput(ctx *gin.Context) {
	execId := ctx.Param("execId")

	exec, ok := execManager.Get(execId)
	if !ok {
		ctx.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("execution %s not found", execId)})
		return
	}

	ctx.Header("Content-Type", "text/event-stream")
	ctx.Header("Cache-Control", "no-cache")
	ctx.Header("Connection", "keep-alive")
	ctx.Status(http.StatusOK)

	flusher, canFlush := ctx.Writer.(http.Flusher)

	stdoutDone := make(chan struct{})
	stderrDone := make(chan struct{})

	// Stream stdout
	go func() {
		defer close(stdoutDone)
		buf := make([]byte, 4096)
		for {
			n, err := exec.StdoutR.Read(buf)
			if n > 0 {
				encoded := boxlite.EncodeSSEData(buf[:n])
				fmt.Fprintf(ctx.Writer, "event: stdout\ndata: {\"data\":\"%s\"}\n\n", encoded)
				if canFlush {
					flusher.Flush()
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Stream stderr
	go func() {
		defer close(stderrDone)
		buf := make([]byte, 4096)
		for {
			n, err := exec.StderrR.Read(buf)
			if n > 0 {
				encoded := boxlite.EncodeSSEData(buf[:n])
				fmt.Fprintf(ctx.Writer, "event: stderr\ndata: {\"data\":\"%s\"}\n\n", encoded)
				if canFlush {
					flusher.Flush()
				}
			}
			if err != nil {
				return
			}
		}
	}()

	<-stdoutDone
	<-stderrDone

	select {
	case <-exec.Done:
		exitData, _ := json.Marshal(map[string]interface{}{
			"exit_code": exec.ExitCode,
		})
		fmt.Fprintf(ctx.Writer, "event: exit\ndata: %s\n\n", string(exitData))
	default:
		fmt.Fprintf(ctx.Writer, "event: exit\ndata: {\"exit_code\":-1}\n\n")
	}
	if canFlush {
		flusher.Flush()
	}
}

func BoxliteExecInput(ctx *gin.Context) {
	execId := ctx.Param("execId")

	data, err := io.ReadAll(ctx.Request.Body)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "failed to read body"})
		return
	}

	if err := execManager.WriteStdin(execId, data); err != nil {
		ctx.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	ctx.Status(http.StatusNoContent)
}

func BoxliteExecSignal(ctx *gin.Context) {
	execId := ctx.Param("execId")

	if err := execManager.Signal(execId); err != nil {
		ctx.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	ctx.Status(http.StatusNoContent)
}

func BoxliteExecResize(ctx *gin.Context) {
	// TTY resize — not yet supported by Go SDK session API
	ctx.Status(http.StatusNoContent)
}
