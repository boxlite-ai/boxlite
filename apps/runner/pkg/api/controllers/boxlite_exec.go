package controllers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
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

type execOutputEvent struct {
	name string
	data []byte
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

	streamManagedExecOutput(ctx.Request.Context(), ctx.Writer, exec)
}

func streamManagedExecOutput(ctx context.Context, writer http.ResponseWriter, exec *boxlite.ManagedExec) {
	flusher, canFlush := writer.(http.Flusher)
	events := make(chan execOutputEvent, 16)

	var readers sync.WaitGroup
	readers.Add(2)
	go pipeExecOutput(ctx, &readers, exec.StdoutR, "stdout", events)
	go pipeExecOutput(ctx, &readers, exec.StderrR, "stderr", events)

	go func() {
		readers.Wait()
		close(events)
	}()

	for {
		select {
		case event, ok := <-events:
			if !ok {
				writeExecExit(ctx, writer, flusher, canFlush, exec)
				return
			}
			writeExecOutputEvent(writer, event.name, event.data)
			if canFlush {
				flusher.Flush()
			}
		case <-ctx.Done():
			return
		}
	}
}

func writeExecExit(
	ctx context.Context,
	writer http.ResponseWriter,
	flusher http.Flusher,
	canFlush bool,
	exec *boxlite.ManagedExec,
) {
	if exec.TTY {
		writeExecExitIfDone(writer, exec)
		if canFlush {
			flusher.Flush()
		}
		return
	}

	select {
	case <-exec.Done:
	case <-ctx.Done():
		return
	}

	writeExecExitEvent(writer, exec)
	if canFlush {
		flusher.Flush()
	}
}

func pipeExecOutput(
	ctx context.Context,
	readers *sync.WaitGroup,
	reader io.Reader,
	name string,
	events chan<- execOutputEvent,
) {
	defer readers.Done()
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])

			select {
			case events <- execOutputEvent{name: name, data: data}:
			case <-ctx.Done():
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func writeExecOutputEvent(writer io.Writer, name string, data []byte) {
	encoded := boxlite.EncodeSSEData(data)
	fmt.Fprintf(writer, "event: %s\ndata: {\"data\":\"%s\"}\n\n", name, encoded)
}

func writeExecExitEvent(writer io.Writer, exec *boxlite.ManagedExec) {
	exitData := map[string]interface{}{
		"exit_code": exec.ExitCode,
	}
	if exec.Err != nil {
		exitData["error"] = exec.Err.Error()
	}
	encoded, _ := json.Marshal(exitData)
	fmt.Fprintf(writer, "event: exit\ndata: %s\n\n", string(encoded))
}

func writeExecExitIfDone(writer io.Writer, exec *boxlite.ManagedExec) {
	select {
	case <-exec.Done:
		writeExecExitEvent(writer, exec)
	default:
		fmt.Fprint(writer, "event: exit\ndata: {\"exit_code\":-1}\n\n")
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
	execId := ctx.Param("execId")

	var req ResizeRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request: %s", err)})
		return
	}

	if err := execManager.ResizeTTY(execId, int(req.Rows), int(req.Cols)); err != nil {
		ctx.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	ctx.Status(http.StatusNoContent)
}
