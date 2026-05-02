package boxlite

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"sync"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/google/uuid"
)

type ExecManager struct {
	mu    sync.RWMutex
	execs map[string]*ManagedExec
}

type ManagedExec struct {
	ID        string
	StdoutR   *io.PipeReader
	StderrR   *io.PipeReader
	stdinW    io.Writer
	execution *boxlite.Execution
	Done      chan struct{}
	ExitCode  int
	Err       error
	TTY       bool
	created   time.Time
}

func NewExecManager() *ExecManager {
	m := &ExecManager{execs: make(map[string]*ManagedExec)}
	go m.cleanupLoop()
	return m
}

func (m *ExecManager) Start(ctx context.Context, bx *boxlite.Box, command string, args []string, tty bool) (string, error) {
	id := uuid.New().String()

	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()

	exec := &ManagedExec{
		ID:      id,
		StdoutR: stdoutR,
		StderrR: stderrR,
		Done:    make(chan struct{}),
		TTY:     tty,
		created: time.Now(),
	}

	execution, err := bx.StartExecution(ctx, command, args, &boxlite.ExecutionOptions{
		TTY:    tty,
		Stdout: stdoutW,
		Stderr: stderrW,
	})
	if err != nil {
		stdoutW.Close()
		stderrW.Close()
		stdoutR.Close()
		stderrR.Close()
		return "", fmt.Errorf("failed to start execution: %w", err)
	}
	exec.execution = execution
	exec.stdinW = execution.Stdin

	go func() {
		defer close(exec.Done)
		defer stdoutW.Close()
		defer stderrW.Close()
		defer execution.Close()

		exitCode, err := execution.Wait(context.Background())
		exec.ExitCode = exitCode
		exec.Err = err
	}()

	m.mu.Lock()
	m.execs[id] = exec
	m.mu.Unlock()

	return id, nil
}

func (m *ExecManager) Get(id string) (*ManagedExec, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.execs[id]
	return e, ok
}

func (m *ExecManager) WriteStdin(id string, data []byte) error {
	m.mu.RLock()
	e, ok := m.execs[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("execution %s not found", id)
	}
	if e.stdinW == nil {
		return fmt.Errorf("execution %s has no stdin (non-tty mode)", id)
	}
	_, err := e.stdinW.Write(data)
	return err
}

func (m *ExecManager) Signal(id string) error {
	m.mu.Lock()
	e, ok := m.execs[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("execution %s not found", id)
	}
	delete(m.execs, id)
	m.mu.Unlock()

	var err error
	if e.execution != nil {
		err = e.execution.Kill(context.Background())
	}
	e.StdoutR.Close()
	e.StderrR.Close()
	return err
}

func (m *ExecManager) ResizeTTY(id string, rows, cols int) error {
	m.mu.RLock()
	e, ok := m.execs[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("execution %s not found", id)
	}
	if e.execution == nil {
		return fmt.Errorf("execution %s is closed", id)
	}
	if !e.TTY {
		return fmt.Errorf("execution %s is not a TTY", id)
	}
	return e.execution.ResizeTTY(context.Background(), rows, cols)
}

func (m *ExecManager) cleanupLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		m.mu.Lock()
		for id, e := range m.execs {
			if time.Since(e.created) > 5*time.Minute {
				select {
				case <-e.Done:
					e.StdoutR.Close()
					e.StderrR.Close()
					delete(m.execs, id)
				default:
				}
			}
		}
		m.mu.Unlock()
	}
}

func EncodeSSEData(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}
