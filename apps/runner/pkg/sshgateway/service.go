// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package sshgateway

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"

	boxlitesdk "github.com/boxlite-ai/boxlite/sdks/go"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/shellutil"
	"golang.org/x/crypto/ssh"
)

type Service struct {
	log     *slog.Logger
	boxlite *blclient.Client
	port    int
}

func NewService(logger *slog.Logger, boxlite *blclient.Client) *Service {
	port := GetSSHGatewayPort()

	service := &Service{
		log:     logger.With(slog.String("component", "ssh_gateway_service")),
		boxlite: boxlite,
		port:    port,
	}

	return service
}

// GetPort returns the port the SSH gateway is configured to use
func (s *Service) GetPort() int {
	return s.port
}

// Start starts the SSH gateway server
func (s *Service) Start(ctx context.Context) error {
	// Get the public key from configuration
	publicKeyString, err := GetSSHPublicKey()
	if err != nil {
		return fmt.Errorf("failed to get SSH public key from config: %w", err)
	}

	// Parse the public key from config
	configPublicKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(publicKeyString))
	if err != nil {
		return fmt.Errorf("failed to parse SSH public key from config: %w", err)
	}

	// Get the host key from configuration
	hostKey, err := GetSSHHostKey()
	if err != nil {
		return fmt.Errorf("failed to get SSH host key from config: %w", err)
	}

	serverConfig := &ssh.ServerConfig{
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			// The username should be the sandbox ID
			sandboxId := conn.User()

			// Check if the provided key matches the configured public key
			if key.Type() == configPublicKey.Type() && bytes.Equal(key.Marshal(), configPublicKey.Marshal()) {
				return &ssh.Permissions{
					Extensions: map[string]string{
						"sandbox-id": sandboxId,
					},
				}, nil
			}

			s.log.WarnContext(ctx, "Public key authentication failed for sandbox", "sandboxID", sandboxId)
			return nil, fmt.Errorf("authentication failed")
		},
		NoClientAuth: false,
	}

	serverConfig.AddHostKey(hostKey)

	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", s.port))
	if err != nil {
		return fmt.Errorf("failed to listen on port %d: %w", s.port, err)
	}
	defer listener.Close()

	s.log.InfoContext(ctx, "SSH Gateway listening on port", "port", s.port)

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
			conn, err := listener.Accept()
			if err != nil {
				s.log.WarnContext(ctx, "Failed to accept incoming connection", "error", err)
				continue
			}

			go s.handleConnection(ctx, conn, serverConfig)
		}
	}
}

// handleConnection handles an individual SSH connection
func (s *Service) handleConnection(ctx context.Context, conn net.Conn, serverConfig *ssh.ServerConfig) {
	defer conn.Close()

	serverConn, chans, reqs, err := ssh.NewServerConn(conn, serverConfig)
	if err != nil {
		s.log.Warn("Failed to handshake", "error", err)
		return
	}
	defer serverConn.Close()

	sandboxId := serverConn.Permissions.Extensions["sandbox-id"]

	// Discard global requests; we don't currently forward any.
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		go s.handleChannel(ctx, newChannel, sandboxId)
	}
}

// handleChannel bridges an SSH session channel to an in-VM exec via the
// BoxLite SDK (libkrun vsock), the same primitive the dashboard's WebSocket
// terminal uses at apps/runner/pkg/api/controllers/proxy.go:114. There is no
// host-side hostname lookup, no `ssh.Dial` to a sandbox-internal address —
// the kernel routes the spawn through libkrun and pipes stdio over the
// connection's file descriptors.
func (s *Service) handleChannel(ctx context.Context, newChannel ssh.NewChannel, sandboxId string) {
	if newChannel.ChannelType() != "session" {
		_ = newChannel.Reject(ssh.UnknownChannelType, "only session channels are supported")
		return
	}

	clientChannel, clientRequests, err := newChannel.Accept()
	if err != nil {
		s.log.Warn("Could not accept client channel", "error", err)
		return
	}

	// When a client opens a session without an explicit `exec` request
	// (typical interactive ssh), pick the best available shell at exec
	// time via the shared launcher used by the dashboard terminal too.
	defaultCmd, defaultArgs := shellutil.DefaultInteractiveShell()

	state := &sessionState{
		log:           s.log,
		boxlite:       s.boxlite,
		sandboxId:     sandboxId,
		clientChannel: clientChannel,
		cmd:           defaultCmd,
		args:          defaultArgs,
		rows:          24,
		cols:          80,
	}

	execCtx, cancelExec := context.WithCancel(ctx)
	defer cancelExec()

	for req := range clientRequests {
		if req == nil {
			break
		}
		s.handleRequest(execCtx, state, req)
		// Once the exec has started, channel teardown is driven by the
		// exec's exit (see runExec); we just keep forwarding signal/env/
		// window-change requests until the SSH channel is closed.
	}

	state.waitForExitAndClose()
}

// sessionState carries the per-channel mutable state across the request stream
// and the spawned exec. Methods on it are not safe for concurrent use except
// where explicitly noted (window-change runs on the request goroutine; the
// stdin pump and exit waiter run on goroutines started by runExec).
type sessionState struct {
	log           *slog.Logger
	boxlite       *blclient.Client
	sandboxId     string
	clientChannel ssh.Channel

	// Negotiated before exec start.
	withTTY bool
	cmd     string
	args    []string
	rows    int
	cols    int

	// Set when runExec succeeds.
	mu       sync.Mutex
	exec     *boxlitesdk.Execution
	started  bool
	exitDone chan int // exit code (or -1 on error); closed by exit waiter
}

func (s *Service) handleRequest(ctx context.Context, st *sessionState, req *ssh.Request) {
	switch req.Type {
	case "pty-req":
		dims := parsePtyReq(req.Payload)
		st.withTTY = true
		if dims.rows > 0 && dims.cols > 0 {
			st.rows, st.cols = dims.rows, dims.cols
		}
		// Resize if already started (rare — clients usually send pty-req first).
		if st.startedExec() {
			st.resize(ctx)
		}
		_ = req.Reply(true, nil)

	case "env":
		// Accept env requests without forwarding; the in-VM exec runs in
		// its own environment. This matches OpenSSH default behaviour
		// for unknown env vars (silently ignored).
		_ = req.Reply(true, nil)

	case "shell":
		_ = req.Reply(true, nil)
		st.runExec(ctx, "shell")

	case "exec":
		cmd, ok := parseStringPayload(req.Payload)
		if !ok {
			_ = req.Reply(false, nil)
			return
		}
		// SSH "exec" payload is a single command string; run via shell -c
		// so the user can include pipes / redirects without us parsing.
		st.cmd = "/bin/sh"
		st.args = []string{"-c", cmd}
		_ = req.Reply(true, nil)
		st.runExec(ctx, "exec")

	case "subsystem":
		// Modern OpenSSH scp defaults to the SFTP subsystem (RFC 4254 §6.5).
		// Spawn an sftp-server binary inside the VM; its stdio gets wired
		// to the SSH channel just like a regular exec. The launcher in
		// shellutil.SftpSubsystem probes common install paths and refuses
		// to exec an empty path so the client sees a real error instead
		// of a silent "Connection closed".
		name, ok := parseStringPayload(req.Payload)
		if !ok || name != "sftp" {
			_ = req.Reply(false, nil)
			return
		}
		st.cmd, st.args = shellutil.SftpSubsystem()
		// No TTY for binary-protocol subsystems.
		st.withTTY = false
		_ = req.Reply(true, nil)
		st.runExec(ctx, "subsystem:sftp")

	case "window-change":
		dims := parseWindowChange(req.Payload)
		if dims.rows > 0 && dims.cols > 0 {
			st.rows, st.cols = dims.rows, dims.cols
			if st.startedExec() {
				st.resize(ctx)
			}
		}
		// window-change has want_reply=false per RFC 4254.

	case "signal":
		// Best-effort: the SDK does not currently expose a kill primitive
		// for in-flight executions other than Close(). Ignore for now.
		// (Closing the channel triggers exec cleanup; that is enough for
		// interactive sessions to terminate via Ctrl-C → SIGINT in pty.)

	default:
		s.log.Debug("Ignoring unsupported channel request", "type", req.Type, "sandboxID", st.sandboxId)
		if req.WantReply {
			_ = req.Reply(false, nil)
		}
	}
}

// runExec starts the in-VM exec and wires SSH-channel stdio to it. Idempotent:
// a second `shell`/`exec` request after one has already started is a no-op.
func (st *sessionState) runExec(ctx context.Context, kind string) {
	st.mu.Lock()
	if st.started {
		st.mu.Unlock()
		return
	}
	st.started = true
	st.exitDone = make(chan int, 1)
	st.mu.Unlock()

	// In TTY mode, the in-VM kernel merges stdout/stderr onto the pty
	// master, so both writers point at the SSH channel. Without a TTY,
	// stderr goes to the SSH channel's extended (stderr) stream so the
	// client can distinguish 1/2.
	var stdout, stderr io.Writer = st.clientChannel, st.clientChannel.Stderr()
	if st.withTTY {
		stderr = st.clientChannel
	}

	st.log.Info("Starting exec in sandbox",
		"sandboxID", st.sandboxId,
		"cmd", st.cmd,
		"tty", st.withTTY,
		"kind", kind,
	)

	exec, err := st.boxlite.StartExecution(ctx, st.sandboxId, st.cmd, st.args, stdout, stderr, st.withTTY)
	if err != nil {
		st.log.Warn("Failed to start execution in sandbox", "sandboxID", st.sandboxId, "error", err)
		_, _ = st.clientChannel.SendRequest("exit-status", false, exitStatusPayload(127))
		_ = st.clientChannel.Close()
		st.exitDone <- 127
		close(st.exitDone)
		return
	}

	st.mu.Lock()
	st.exec = exec
	st.mu.Unlock()

	// Apply initial window size if pty-req sent dims.
	if st.withTTY {
		st.resize(ctx)
	}

	// Pump SSH channel stdin → exec stdin until either side closes.
	go func() {
		defer func() {
			// Close stdin so the in-VM process sees EOF (some commands
			// need this to exit). Errors are ignored — channel may already
			// be torn down.
			if exec.Stdin != nil {
				_ = exec.Stdin.Close()
			}
		}()
		if _, err := io.Copy(exec.Stdin, st.clientChannel); err != nil && err != io.EOF {
			st.log.Debug("stdin pump ended", "sandboxID", st.sandboxId, "error", err)
		}
	}()

	// Wait for the in-VM process to exit, then send SSH exit-status and
	// close the channel. This goroutine is the channel's owner-of-record
	// for shutdown; the request loop returns naturally once the channel
	// closes.
	go func() {
		exitCode, werr := exec.Wait(ctx)
		if werr != nil && exitCode == 0 {
			// Surface plumbing errors as a non-zero exit; openssh maps
			// 255 to "session closed by remote". Keep this distinct from
			// a genuine 0 exit.
			exitCode = 255
			st.log.Warn("exec.Wait returned error",
				"sandboxID", st.sandboxId, "error", werr)
		}
		st.log.Info("Exec completed",
			"sandboxID", st.sandboxId, "exitCode", exitCode)
		_, _ = st.clientChannel.SendRequest("exit-status", false, exitStatusPayload(exitCode))
		_ = exec.Close()
		_ = st.clientChannel.Close()
		st.exitDone <- exitCode
		close(st.exitDone)
	}()
}

// startedExec reports whether runExec has been called. Holds mu only briefly.
func (st *sessionState) startedExec() bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.exec != nil
}

// resize forwards the current rows/cols to the in-VM TTY. No-op if exec
// isn't running yet or isn't a TTY.
func (st *sessionState) resize(ctx context.Context) {
	st.mu.Lock()
	exec, rows, cols := st.exec, st.rows, st.cols
	st.mu.Unlock()
	if exec == nil || !st.withTTY {
		return
	}
	if err := exec.ResizeTTY(ctx, rows, cols); err != nil {
		st.log.Debug("ResizeTTY failed", "sandboxID", st.sandboxId, "error", err)
	}
}

// waitForExitAndClose blocks until the exit-waiter has reported a code,
// so the connection-level defers (which include logging completion) don't
// race ahead of the channel's actual teardown. Safe to call when runExec
// never started; in that case there's nothing to wait for.
func (st *sessionState) waitForExitAndClose() {
	st.mu.Lock()
	done := st.exitDone
	st.mu.Unlock()
	if done == nil {
		_ = st.clientChannel.Close()
		return
	}
	<-done
}

// ── payload helpers ─────────────────────────────────────────────────────────

type ptyDims struct{ rows, cols int }

// parsePtyReq pulls (rows, cols) out of an SSH "pty-req" payload per RFC 4254 §6.2:
//
//	string  TERM
//	uint32  cols
//	uint32  rows
//	uint32  width-px
//	uint32  height-px
//	string  encoded-terminal-modes
func parsePtyReq(p []byte) ptyDims {
	rest, _, ok := readSSHString(p)
	if !ok || len(rest) < 8 {
		return ptyDims{}
	}
	cols := binary.BigEndian.Uint32(rest[0:4])
	rows := binary.BigEndian.Uint32(rest[4:8])
	return ptyDims{rows: int(rows), cols: int(cols)}
}

// parseWindowChange pulls (rows, cols) from an SSH "window-change" payload
// per RFC 4254 §6.7:
//
//	uint32 cols ; uint32 rows ; uint32 wpx ; uint32 hpx
func parseWindowChange(p []byte) ptyDims {
	if len(p) < 8 {
		return ptyDims{}
	}
	cols := binary.BigEndian.Uint32(p[0:4])
	rows := binary.BigEndian.Uint32(p[4:8])
	return ptyDims{rows: int(rows), cols: int(cols)}
}

// parseStringPayload reads a single SSH string from `p`. Used for "exec"
// requests where the entire payload is a single command string.
func parseStringPayload(p []byte) (string, bool) {
	_, s, ok := readSSHString(p)
	return s, ok
}

// readSSHString reads a length-prefixed string off the front of p and returns
// (remaining, value, ok).
func readSSHString(p []byte) ([]byte, string, bool) {
	if len(p) < 4 {
		return nil, "", false
	}
	n := binary.BigEndian.Uint32(p[0:4])
	if uint64(len(p)) < 4+uint64(n) {
		return nil, "", false
	}
	return p[4+n:], string(p[4 : 4+n]), true
}

// exitStatusPayload encodes an SSH "exit-status" channel request payload:
//
//	uint32 exit-status
func exitStatusPayload(code int) []byte {
	if code < 0 {
		code = 255
	}
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, uint32(code))
	return buf
}
