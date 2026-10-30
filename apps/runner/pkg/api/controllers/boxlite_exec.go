package controllers

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

var execManager = boxlite.NewExecManager()

var getExecutionBox = func(ctx *gin.Context, boxID string) (*sdkboxlite.Box, error) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		return nil, err
	}
	return r.Boxlite.GetBox(ctx.Request.Context(), boxID)
}

func resolveManagedExecution(ctx *gin.Context, boxID, execID string, attach bool) (*boxlite.ManagedExec, error) {
	if !attach {
		if current, err := execManager.GetForBox(execID, boxID); !errors.Is(err, boxlite.ErrExecNotFound) {
			return current, err
		}
	}
	bx, err := getExecutionBox(ctx, boxID)
	if err != nil {
		return nil, fmt.Errorf("box not found: %w", err)
	}
	if attach {
		return execManager.Attach(ctx.Request.Context(), bx, execID, boxID)
	}
	return execManager.Resolve(ctx.Request.Context(), bx, execID, boxID)
}

func BoxliteListExecutions(ctx *gin.Context) {
	bx, err := getExecutionBox(ctx, ctx.Param("boxId"))
	if err != nil {
		ctx.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("box not found: %s", err)})
		return
	}
	entries, err := bx.ListExecutions(ctx.Request.Context())
	if err != nil {
		ctx.JSON(execStartStatus(err), gin.H{"error": err.Error()})
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"executions": entries})
}

type ExecRequest struct {
	Command        string            `json:"command"`
	Args           []string          `json:"args"`
	Env            map[string]string `json:"env"`
	TimeoutSeconds *float64          `json:"timeout_seconds"`
	WorkingDir     *string           `json:"working_dir"`
	TTY            bool              `json:"tty"`
	User           string            `json:"user"`
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

	execId, err := execManager.Start(ctx.Request.Context(), bx, boxId, startOptionsFrom(req))
	if err != nil {
		ctx.JSON(execStartStatus(err), gin.H{"error": fmt.Sprintf("exec failed: %s", err)})
		return
	}

	ctx.JSON(http.StatusCreated, ExecResponse{ExecutionID: execId})
}

// startOptionsFrom translates the wire request into the exec start options.
// Absent WorkingDir/TimeoutSeconds leave the zero values, matching the
// "absent means default" contract in openapi/box.openapi.yaml.
func startOptionsFrom(req ExecRequest) boxlite.StartOptions {
	startOpts := boxlite.StartOptions{
		Command: req.Command,
		Args:    req.Args,
		Env:     req.Env,
		TTY:     req.TTY,
		User:    req.User,
	}
	if req.WorkingDir != nil {
		startOpts.WorkingDir = *req.WorkingDir
	}
	if req.TimeoutSeconds != nil {
		// The Rust C-FFI treats `timeout_secs <= 0` as unbounded (see
		// `sdks/c/src/exec/command.rs`), so a 0 or negative value here
		// is equivalent to omitting the field — pass it straight through.
		startOpts.Timeout = time.Duration(*req.TimeoutSeconds * float64(time.Second))
	}
	return startOpts
}

// execStartStatus classifies a failed exec start into the HTTP status the
// caller should see. A stopped / wrong-state box is a 409: the box exists
// but isn't accepting execs right now, and answering 500 leaks
//
//	internal error: HTTP 500 Internal Server Error:
//	{"error":"exec failed: failed to start execution: boxlite: stopped:
//	 Handle invalidated after stop(). ... (code=11)"}
//
// and fires the SDK's 'all 5xx is bug' guard. An unknown user or group is
// the caller's mistake (400), not a runner fault — answering 500 there would
// hide the #2116 misclassification. Everything else is a runner fault (500).
func execStartStatus(err error) int {
	if sdkboxlite.IsStopped(err) || sdkboxlite.IsInvalidState(err) {
		return http.StatusConflict
	}
	if sdkboxlite.IsInvalidArgument(err) {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

// allowedExecSignals is the whitelist of POSIX signal numbers callers may
// deliver via the signal endpoint. SIGKILL (9) is excluded — clients should
// use DELETE /executions/{id} (BoxliteExecKill) for that, which also evicts
// the registry entry. STOP variants (17, 19, 23) and SIGCONT (18) are
// excluded because pausing an exec via the runner API leaks process state
// the rest of the system can't observe.
var allowedExecSignals = map[int]struct{}{
	1:  {}, // SIGHUP
	2:  {}, // SIGINT
	3:  {}, // SIGQUIT
	6:  {}, // SIGABRT
	10: {}, // SIGUSR1
	12: {}, // SIGUSR2
	15: {}, // SIGTERM
	28: {}, // SIGWINCH
}

func BoxliteExecSignal(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	execId := ctx.Param("execId")

	var req SignalRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request: %s", err)})
		return
	}

	if _, ok := allowedExecSignals[req.Signal]; !ok {
		ctx.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf(
				"signal %d is not permitted; use DELETE /executions/{id} for SIGKILL, and only signals 1, 2, 3, 6, 10, 12, 15, 28 are accepted",
				req.Signal,
			),
		})
		return
	}

	if _, err := resolveManagedExecution(ctx, boxId, execId, false); err != nil {
		ctx.JSON(classifyExecError(err), gin.H{"error": err.Error()})
		return
	}

	if err := execManager.Signal(execId, req.Signal); err != nil {
		ctx.JSON(classifyExecError(err), gin.H{"error": err.Error()})
		return
	}

	ctx.Status(http.StatusNoContent)
}

// BoxliteExecKill terminates an execution with SIGKILL and evicts it from
// the registry. Returns 204 on success, 404 if the execution is not
// registered.
func BoxliteExecKill(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	execId := ctx.Param("execId")

	if _, err := resolveManagedExecution(ctx, boxId, execId, false); err != nil {
		ctx.JSON(classifyExecError(err), gin.H{"error": err.Error()})
		return
	}

	if err := execManager.Kill(execId); err != nil {
		ctx.JSON(classifyExecError(err), gin.H{"error": err.Error()})
		return
	}

	ctx.Status(http.StatusNoContent)
}

// BoxliteGetExecution returns the current status of an execution without
// streaming. The response shape matches the OpenAPI ExecutionInfo schema:
// while still running, only execution_id and status are populated; once
// Done has fired, exit_code (and error_message when present) are filled in.
func BoxliteGetExecution(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	execId := ctx.Param("execId")

	exec, err := resolveManagedExecution(ctx, boxId, execId, false)
	if err != nil {
		ctx.JSON(classifyExecError(err), gin.H{"error": err.Error()})
		return
	}

	ctx.JSON(http.StatusOK, executionInfoFromManagedExec(exec))
}

// ExecutionInfoResponse describes an execution's current state.
// Field names match the OpenAPI ExecutionInfo schema:
// execution_id, status, exit_code, error_message. Statuses are
// running | completed | killed | timed_out per spec; today we only
// emit running and completed (the latter covers any non-running state
// the kernel surfaced — exit-code semantics distinguish them).
// exit_code and error_message are populated only after Done fires so
// callers can distinguish "still running" from "exited cleanly with
// code 0".
type ExecutionInfoResponse struct {
	ExecutionID  string `json:"execution_id"`
	Status       string `json:"status"`
	ExitCode     *int   `json:"exit_code,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

func executionInfoFromManagedExec(exec *boxlite.ManagedExec) ExecutionInfoResponse {
	resp := ExecutionInfoResponse{ExecutionID: exec.ID}
	select {
	case <-exec.Done:
		resp.Status = "completed"
		code := exec.ExitCode
		resp.ExitCode = &code
		if exec.Err != nil {
			resp.ErrorMessage = exec.Err.Error()
		}
	default:
		resp.Status = "running"
	}
	return resp
}

func BoxliteExecResize(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	execId := ctx.Param("execId")

	var req ResizeRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid request: %s", err)})
		return
	}

	if _, err := resolveManagedExecution(ctx, boxId, execId, false); err != nil {
		ctx.JSON(classifyExecError(err), gin.H{"error": err.Error()})
		return
	}

	if err := execManager.ResizeTTY(execId, int(req.Rows), int(req.Cols)); err != nil {
		ctx.JSON(classifyExecError(err), gin.H{"error": err.Error()})
		return
	}

	ctx.Status(http.StatusNoContent)
}

func classifyExecError(err error) int {
	switch {
	case errors.Is(err, boxlite.ErrExecNotFound), errors.Is(err, boxlite.ErrBoxMismatch), sdkboxlite.IsNotFound(err):
		return http.StatusNotFound
	case errors.Is(err, boxlite.ErrExecClosed), errors.Is(err, boxlite.ErrExecReaping),
		sdkboxlite.IsAlreadyExists(err), sdkboxlite.IsInvalidState(err), sdkboxlite.IsStopped(err):
		return http.StatusConflict
	case errors.Is(err, boxlite.ErrExecNotTTY), sdkboxlite.IsInvalidArgument(err):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}
