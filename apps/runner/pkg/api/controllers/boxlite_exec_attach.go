// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// wsKeepaliveInterval is how often the server sends a WebSocket Ping on
// idle attach connections. Exposed as a package var so tests can speed
// the interval up via setKeepaliveIntervalForTest.
var (
	wsKeepaliveInterval   = 15 * time.Second
	wsKeepaliveIntervalMu sync.RWMutex
)

func keepaliveInterval() time.Duration {
	wsKeepaliveIntervalMu.RLock()
	defer wsKeepaliveIntervalMu.RUnlock()
	return wsKeepaliveInterval
}

// setKeepaliveIntervalForTest is the synchronized setter used by tests.
func setKeepaliveIntervalForTest(d time.Duration) (restore func()) {
	wsKeepaliveIntervalMu.Lock()
	prev := wsKeepaliveInterval
	wsKeepaliveInterval = d
	wsKeepaliveIntervalMu.Unlock()
	return func() {
		wsKeepaliveIntervalMu.Lock()
		wsKeepaliveInterval = prev
		wsKeepaliveIntervalMu.Unlock()
	}
}

const (
	// wsWriteDeadline bounds every server write. Generous relative to
	// wsKeepaliveInterval so a slow client doesn't break a healthy
	// session, but short enough to surface dead peers.
	wsWriteDeadline = 20 * time.Second

	// chanStdout / chanStderr prefix server→client binary frames so a
	// single binary channel multiplexes both pipes.
	chanStdout byte = 0x01
	chanStderr byte = 0x02

	// wsPeerCloseWait bounds how long the connection stays open after the
	// server has sent its own Close frame, waiting for the peer's.
	//
	// RFC 6455 §5.5.1 makes the close a handshake: an endpoint drops the TCP
	// connection once it has both sent and received a Close. Dropping it in
	// the same millisecond we send ours also strands whatever is still
	// relaying our 101 to the client, which reads as an upgrade that never
	// completed — Google's external Application Load Balancer logs exactly
	// that connection as `websocket_handshake_failed` and answers the client
	// 502. It is why an exec whose command exits inside one round trip
	// (`echo hello`) intermittently loses its output: upgrade, backlog
	// replay, exit frame and close all land in ~20ms, well inside a
	// handshake the balancer has not finished.
	//
	// Costs nothing in the common case — a client answers or drops the
	// socket as soon as it has the exit frame, about one round trip. This
	// bound covers only a peer that does neither.
	wsPeerCloseWaitDefault = 5 * time.Second
)

// wsPeerCloseWait is a package var for the same reason wsKeepaliveInterval is:
// a test cannot spend the real bound to prove the bound exists.
var (
	wsPeerCloseWait   = wsPeerCloseWaitDefault
	wsPeerCloseWaitMu sync.RWMutex
)

func peerCloseWait() time.Duration {
	wsPeerCloseWaitMu.RLock()
	defer wsPeerCloseWaitMu.RUnlock()
	return wsPeerCloseWait
}

// setPeerCloseWaitForTest is the synchronized setter used by tests.
func setPeerCloseWaitForTest(d time.Duration) (restore func()) {
	wsPeerCloseWaitMu.Lock()
	prev := wsPeerCloseWait
	wsPeerCloseWait = d
	wsPeerCloseWaitMu.Unlock()
	return func() {
		wsPeerCloseWaitMu.Lock()
		wsPeerCloseWait = prev
		wsPeerCloseWaitMu.Unlock()
	}
}

// attachExec is the surface of an exec session needed by the WebSocket
// handler. *boxlite.ManagedExec implements it via a thin adapter; tests
// substitute their own stubs.
type attachExec interface {
	// Subscribe registers a fan-out subscriber and returns its stdout/stderr
	// channels plus a cancel function that must be called when the /attach
	// session ends. The broadcaster owns the underlying pipe readers for
	// the exec's lifetime, so there is no stale-pump race on reattach.
	Subscribe(bufSize int) (stdout, stderr <-chan []byte, cancel func())

	WriteStdin(data []byte) (int, error)
	DoneCh() <-chan struct{}
	ExitCodeValue() int
	IsTTY() bool
	Resize(rows, cols int) error
	Signal(sig int) error
	CloseStdin() error

	// MarkConnected attempts to claim the single-attach slot; returns
	// false if another client is already attached.
	MarkConnected() bool
	// MarkDisconnected releases the slot and stamps LastDisconnectAt
	// for Phase 4 reaping.
	MarkDisconnected()
}

// resolveAttachExec is the production lookup; tests override.
var resolveAttachExec = func(execId, boxId string) (attachExec, bool) {
	me, err := execManager.GetForBox(execId, boxId)
	if err != nil {
		return nil, false
	}
	return managedExecAttach{me: me}, true
}

// allowedSignals is the in-band signal whitelist mirrored from Phase 2.3
// (HUP/INT/QUIT/ABRT/USR1/USR2/TERM/WINCH). KILL/STOP/CONT are excluded —
// KILL has its own DELETE path and STOP/CONT bypass PTY semantics and
// conflict with the Phase 4 reaper.
var allowedSignals = map[int]struct{}{
	1:  {}, // HUP
	2:  {}, // INT
	3:  {}, // QUIT
	6:  {}, // ABRT
	10: {}, // USR1
	12: {}, // USR2
	15: {}, // TERM
	28: {}, // WINCH
}

func validateInbandSignal(sig int) error {
	if _, ok := allowedSignals[sig]; !ok {
		return fmt.Errorf("signal %d not allowed in attach channel", sig)
	}
	return nil
}

var attachUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// CheckOrigin: attach is auth-protected by the runner middleware
	// chain; CSRF surface is the auth token, not browser origin.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// BoxliteExecAttach upgrades the request to a WebSocket and proxies
// stdin/stdout/stderr/control between the client and the managed exec.
//
//	@Summary	Attach to an execution via WebSocket
//	@Tags		boxlite
//	@Param		boxId	path	string	true	"Box ID"
//	@Param		execId	path	string	true	"Execution ID"
//	@Success	101
//	@Failure	404	{object}	map[string]string	"execution not found"
//	@Failure	409	{object}	map[string]string	"already attached"
//	@Router		/v1/boxes/{boxId}/executions/{execId}/attach [get]
func BoxliteExecAttach(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	execId := ctx.Param("execId")

	target, ok := resolveAttachExec(execId, boxId)
	if !ok {
		ctx.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("execution %s not found", execId)})
		return
	}

	if !target.MarkConnected() {
		// Refuse BEFORE upgrade so the client gets a real HTTP 409.
		ctx.JSON(http.StatusConflict, gin.H{
			"error": fmt.Sprintf("execution %s already attached", execId),
		})
		return
	}

	conn, err := attachUpgrader.Upgrade(ctx.Writer, ctx.Request, nil)
	if err != nil {
		// Upgrade already wrote an error response on its own.
		target.MarkDisconnected()
		return
	}

	runAttachLoop(ctx.Request.Context(), conn, target)
}

// runAttachLoop owns the WebSocket lifecycle: spawns reader/writer/keepalive
// goroutines, waits for the first error to cancel the others, and tears
// down deterministically.
// maxAttachFrameBytes caps inbound WS frames (stdin + control JSON).
// Prevents a malicious client from sending an oversized frame and forcing
// unbounded allocation.
const maxAttachFrameBytes = 1 * 1024 * 1024 // 1 MiB

func runAttachLoop(parentCtx context.Context, conn *websocket.Conn, exec attachExec) {
	conn.SetReadLimit(maxAttachFrameBytes)

	// Detect a dead client via Pong liveness: a tiny Ping write fits in
	// the kernel send buffer and returns success even when the peer is
	// gone, so WriteControl alone cannot surface a half-open TCP. Instead
	// require a Pong (or any frame) within pongWait, otherwise the
	// reader's ReadMessage trips its ReadDeadline and the loop tears
	// down — releasing the single-attach slot for the next client.
	pongWait := 3 * keepaliveInterval()
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))

	loopCtx, cancel := context.WithCancel(parentCtx)
	defer cancel()

	// Set after loopCtx because it has to stop pushing once the loop is
	// cancelled. gorilla calls this from advanceFrame for every Pong, the drain
	// after our own Close included, and a push there would move the deadline
	// pongWait out — past the close-wait bound, and past the near deadline the
	// teardown sets before waiting on this goroutine. A peer that keeps ponging
	// would otherwise hold the socket and the single-attach slot behind it.
	conn.SetPongHandler(func(string) error {
		if loopCtx.Err() != nil {
			return nil
		}
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	var (
		writeMu   sync.Mutex     // serializes ALL writes to the WebSocket
		pumpWg    sync.WaitGroup // stdout/stderr pump goroutines only
		sideWg    sync.WaitGroup // reader + keepalive goroutines
		closeOnce sync.Once
	)
	// Closed when the reader goroutine ends, which is how both teardown paths —
	// the normal one below and the deferred panic branch — know the peer has
	// answered our Close or dropped the socket.
	readerDone := make(chan struct{})
	closeWS := func(code int, reason string) {
		closeOnce.Do(func() {
			_ = writeCloseFrame(conn, &writeMu, code, reason)
		})
	}
	// fail cancels the loop on the first non-recoverable error from any
	// goroutine. Subsequent errors are swallowed by the cancelled ctx.
	fail := func(_ error) { cancel() }

	// Subscribe to the exec's per-stream broadcaster. The broadcaster owns
	// the io.PipeReader for the exec's lifetime; this attach session reads
	// from bounded channels that respond to ctx cancellation cleanly.
	// Unsubscribe is deferred so the subscriber slice cannot grow unbounded
	// across reattach cycles.
	stdoutCh, stderrCh, unsubscribe := exec.Subscribe(attachSubscriberBuffer)

	defer func() {
		// Recover from any panic so we don't leak the connection.
		if r := recover(); r != nil {
			fail(fmt.Errorf("attach loop panic: %v", r))
			closeWS(websocket.CloseInternalServerErr, "")
			// A panic unwinds past the wait in the normal flow, and this Close
			// is as owed a handshake as any other — a client that is still
			// there would otherwise get the teardown this whole path avoids.
			awaitPeerClose(conn, readerDone)
		}
		// Every non-panic path has already sent its Close and completed the
		// handshake by the time this runs, so nothing is sent here: closeOnce
		// would make it a no-op, and a second Close after a completed handshake
		// is not something to leave the shape of behind.
		_ = conn.Close()
		// Tear down the subscriber FIRST so the broadcaster stops fanning
		// chunks into now-dead channels; then release the single-attach
		// slot for the next client (or the Phase 4 reaper).
		unsubscribe()
		exec.MarkDisconnected()
	}()

	// stdout pump (channel-backed; no race with prior attaches because the
	// broadcaster is the sole reader of the pipe).
	pumpWg.Add(1)
	go func() {
		defer pumpWg.Done()
		pumpSubscriberChannel(loopCtx, conn, &writeMu, stdoutCh, chanStdout, fail)
	}()

	// stderr pump (for non-TTY only — TTY merges at the kernel, so stderr
	// stays empty; we still drain via the broadcaster but skip the WS write).
	if !exec.IsTTY() {
		pumpWg.Add(1)
		go func() {
			defer pumpWg.Done()
			pumpSubscriberChannel(loopCtx, conn, &writeMu, stderrCh, chanStderr, fail)
		}()
	}

	// reader (client → server). It is the only thing that observes the peer's
	// Close frame, so its ending is what the close handshake waits on.
	sideWg.Add(1)
	go func() {
		defer sideWg.Done()
		defer close(readerDone)
		readClientFrames(loopCtx, conn, exec, &writeMu, pongWait, fail)
	}()

	// keepalive ping ticker
	sideWg.Add(1)
	go func() {
		defer sideWg.Done()
		runKeepalive(loopCtx, conn, &writeMu, fail)
	}()

	// Wait for either Done (clean exit) or context cancellation (failure
	// or disconnect). Done is the only path that sends an `exit` frame.
	cleanExit := false
	select {
	case <-exec.DoneCh():
		cleanExit = true
	case <-loopCtx.Done():
	}

	if cleanExit {
		// Unsubscribe closes the subscriber channels, which makes the
		// pump goroutines drain their remaining buffered data and exit
		// naturally — no ctx cancellation needed for pumps. This
		// ensures all output is written before the exit frame.
		unsubscribe()

		pumpsDone := make(chan struct{})
		go func() {
			pumpWg.Wait()
			close(pumpsDone)
		}()
		drained := false
		select {
		case <-pumpsDone:
			drained = true
		case <-time.After(2 * time.Second):
		}

		if drained {
			_ = writeJSONFrame(conn, &writeMu, map[string]any{
				"type":      "exit",
				"exit_code": exec.ExitCodeValue(),
			})
			closeWS(websocket.CloseNormalClosure, "")
		} else {
			closeWS(websocket.CloseInternalServerErr, "pump drain timed out")
		}
	} else {
		// The failure exits send their Close here rather than leaving it to the
		// deferred cleanup, so that every path that sends one goes on to
		// complete the handshake below. A cancelled loop is not always a dead
		// peer — a pump write that failed, or an exec that ended badly, leaves
		// a client that is still there and still owed the close.
		closeWS(websocket.CloseGoingAway, "")
	}

	// Cancel before waiting: past our own Close the reader may only drain,
	// never answer. RFC 6455 §5.5.1 forbids a data frame after a Close, and
	// handleControlFrame's error replies are data frames.
	cancel()
	awaitPeerClose(conn, readerDone)

	// Set a near read deadline so conn.ReadMessage() in the reader goroutine
	// unblocks — it does not respect context cancellation and would hang until
	// the TCP keepalive timeout otherwise.
	_ = conn.SetReadDeadline(time.Now())
	sideWg.Wait()
}

// attachSubscriberBuffer is the per-stream chunk buffer size for an attach
// session. With ~4 KB chunks this gives ~1 MB of slack before the broadcaster
// starts dropping chunks for a slow consumer.
const attachSubscriberBuffer = 256

// pumpSubscriberChannel forwards chunks from a broadcaster subscriber channel
// to the WebSocket, prefixing each with the channel byte. Exits cleanly on
// ctx cancellation, channel close (broadcaster ended / unsubscribed), or write
// error.
func pumpSubscriberChannel(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, ch <-chan []byte, channel byte, fail func(error)) {
	for {
		select {
		case <-ctx.Done():
			return
		case chunk, ok := <-ch:
			if !ok {
				return
			}
			frame := make([]byte, len(chunk)+1)
			frame[0] = channel
			copy(frame[1:], chunk)
			if werr := writeBinaryFrame(conn, writeMu, frame); werr != nil {
				fail(fmt.Errorf("write %s frame: %w", channelName(channel), werr))
				return
			}
		}
	}
}

// readClientFrames reads frames from the WebSocket and routes them to the
// exec: binary → stdin, text JSON → control verbs. Pongs are dispatched by
// gorilla inside ReadMessage and reset the deadline via the handler set on
// runAttachLoop; we additionally bump the deadline on every successful
// data/control read so an active session stays alive without depending on
// the pong cadence alone.
func readClientFrames(ctx context.Context, conn *websocket.Conn, exec attachExec, writeMu *sync.Mutex, pongWait time.Duration, fail func(error)) {
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			fail(fmt.Errorf("read client frame: %w", err))
			return
		}
		// Past cancellation this loop only drains, and draining is the point:
		// both branches below write, which §5.5.1 forbids after the Close the
		// caller has already sent — but the reader has to stay on the socket so
		// the peer's own Close can still arrive and end the handshake. Ending
		// the loop on the first frame instead would hand a client with stdin
		// still in flight exactly the teardown this avoids.
		//
		// The deadline is deliberately NOT extended here. A live session pushes
		// it out by pongWait on every frame, which is how an idle client is
		// told from a dead one; a draining one leaves the caller's deadline
		// standing. Together with the pong handler's own cancellation guard
		// that makes the bound absolute, rather than something a talkative peer
		// can keep moving.
		if ctx.Err() != nil {
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))

		switch mt {
		case websocket.BinaryMessage:
			if _, werr := exec.WriteStdin(data); werr != nil {
				_ = writeErrorFrame(conn, writeMu, fmt.Sprintf("stdin write failed: %s", werr))
				continue
			}
		case websocket.TextMessage:
			handleControlFrame(conn, writeMu, exec, data)
		default:
			// Ignore other message types (close handled by ReadMessage err).
		}
	}
}

func handleControlFrame(conn *websocket.Conn, writeMu *sync.Mutex, exec attachExec, data []byte) {
	var msg struct {
		Type string `json:"type"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
		Sig  int    `json:"sig"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		_ = writeErrorFrame(conn, writeMu, fmt.Sprintf("invalid control frame: %s", err))
		return
	}
	switch msg.Type {
	case "resize":
		if err := exec.Resize(msg.Rows, msg.Cols); err != nil {
			_ = writeErrorFrame(conn, writeMu, fmt.Sprintf("resize failed: %s", err))
		}
	case "signal":
		if err := validateInbandSignal(msg.Sig); err != nil {
			_ = writeErrorFrame(conn, writeMu, err.Error())
			return
		}
		if err := exec.Signal(msg.Sig); err != nil {
			_ = writeErrorFrame(conn, writeMu, fmt.Sprintf("signal delivery failed: %s", err))
		}
	case "stdin_eof":
		if err := exec.CloseStdin(); err != nil {
			_ = writeErrorFrame(conn, writeMu, fmt.Sprintf("stdin close failed: %s", err))
		}
	default:
		_ = writeErrorFrame(conn, writeMu, fmt.Sprintf("unknown control type %q", msg.Type))
	}
}

func runKeepalive(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, fail func(error)) {
	// Snapshot the interval once at goroutine start. Tests mutate the
	// package var around setup/teardown; reading it inside the loop
	// would race with their cleanup defers.
	interval := keepaliveInterval()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			writeMu.Lock()
			deadline := time.Now().Add(wsWriteDeadline)
			err := conn.WriteControl(websocket.PingMessage, nil, deadline)
			writeMu.Unlock()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				fail(fmt.Errorf("ping write: %w", err))
				return
			}
		}
	}
}

// --- thread-safe write helpers (gorilla/websocket forbids concurrent writes) ---

func writeBinaryFrame(conn *websocket.Conn, mu *sync.Mutex, payload []byte) error {
	mu.Lock()
	defer mu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(wsWriteDeadline)); err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, payload)
}

func writeJSONFrame(conn *websocket.Conn, mu *sync.Mutex, msg any) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(wsWriteDeadline)); err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, payload)
}

func writeErrorFrame(conn *websocket.Conn, mu *sync.Mutex, message string) error {
	return writeJSONFrame(conn, mu, map[string]any{"type": "error", "message": message})
}

func writeCloseFrame(conn *websocket.Conn, mu *sync.Mutex, code int, reason string) error {
	mu.Lock()
	defer mu.Unlock()
	deadline := time.Now().Add(wsWriteDeadline)
	return conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), deadline)
}

// awaitPeerClose completes the closing handshake started by our own Close
// frame: it holds the connection until the peer answers, drops the socket, or
// wsPeerCloseWait elapses. See the constant for why the wait exists at all.
func awaitPeerClose(conn *websocket.Conn, readerDone <-chan struct{}) {
	// A peer Close frame, a FIN and a reset all surface in the reader's
	// ReadMessage, so the reader ending is the handshake completing. Nothing
	// extends this deadline once the loop is cancelled — neither the reader nor
	// the pong handler — so it is what ends the wait for a peer that answers
	// with nothing. The timer covers the rest: a read deadline is only consulted
	// when a read is outstanding.
	bound := peerCloseWait()
	_ = conn.SetReadDeadline(time.Now().Add(bound))
	timer := time.NewTimer(bound)
	defer timer.Stop()
	select {
	case <-readerDone:
	case <-timer.C:
	}
}

func channelName(c byte) string {
	if c == chanStdout {
		return "stdout"
	}
	return "stderr"
}

// managedExecAttach adapts *boxlite.ManagedExec to attachExec for the
// production lookup path. Lives here (rather than in pkg/boxlite) so the
// adapter doesn't pollute the manager's surface.
type managedExecAttach struct {
	me *boxlite.ManagedExec
}

func (m managedExecAttach) Subscribe(bufSize int) (stdout, stderr <-chan []byte, cancel func()) {
	outSub, errSub, cancel := m.me.Subscribe(bufSize)
	return outSub.Chan(), errSub.Chan(), cancel
}

func (m managedExecAttach) WriteStdin(data []byte) (int, error) { return m.me.AttachWriteStdin(data) }
func (m managedExecAttach) DoneCh() <-chan struct{}             { return m.me.Done }
func (m managedExecAttach) ExitCodeValue() int                  { return m.me.ExitCode }
func (m managedExecAttach) IsTTY() bool                         { return m.me.TTY }
func (m managedExecAttach) Resize(rows, cols int) error         { return m.me.AttachResize(rows, cols) }
func (m managedExecAttach) Signal(sig int) error                { return m.me.AttachSignal(sig) }
func (m managedExecAttach) CloseStdin() error                   { return m.me.AttachCloseStdin() }
func (m managedExecAttach) MarkConnected() bool                 { return m.me.MarkConnected() }
func (m managedExecAttach) MarkDisconnected()                   { m.me.MarkDisconnected() }
