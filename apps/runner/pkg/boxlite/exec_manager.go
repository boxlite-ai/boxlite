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
	ID       string
	StdoutR  *io.PipeReader
	StderrR  *io.PipeReader
	stdinW   io.Writer
	session  *boxlite.Session
	Done     chan struct{}
	ExitCode int
	Err      error
	TTY      bool
	created  time.Time
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

	if tty {
		session, err := bx.StartSession(ctx, command, args, stdoutW, stderrW)
		if err != nil {
			stdoutW.Close()
			stderrW.Close()
			stdoutR.Close()
			stderrR.Close()
			return "", fmt.Errorf("failed to start session: %w", err)
		}
		exec.session = session
		exec.stdinW = sessionWriter{session}
	} else {
		cmd := bx.Command(command, args...)
		cmd.Stdout = stdoutW
		cmd.Stderr = stderrW
		go func() {
			defer close(exec.Done)
			defer stdoutW.Close()
			defer stderrW.Close()
			err := cmd.Run(context.Background())
			exec.ExitCode = cmd.ExitCode()
			exec.Err = err
		}()
	}

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

	if e.session != nil {
		e.session.Close()
	}
	e.StdoutR.Close()
	e.StderrR.Close()
	return nil
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

type sessionWriter struct {
	session *boxlite.Session
}

func (w sessionWriter) Write(p []byte) (int, error) {
	err := w.session.Write(p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}
