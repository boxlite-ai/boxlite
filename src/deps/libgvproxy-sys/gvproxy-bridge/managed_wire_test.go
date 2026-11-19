package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

const heldReplyPayload = "managed UDP partial reply"

type partialGuestWrite struct {
	net.Conn
	entered   chan struct{}
	closed    chan struct{}
	finished  chan struct{}
	closeOnce sync.Once
}

func (c *partialGuestWrite) Write(data []byte) (int, error) {
	if !bytes.HasSuffix(data, []byte(heldReplyPayload)) {
		return c.Conn.Write(data)
	}
	// Write the stream length and only part of the Ethernet frame to the real
	// socket. An owner-driven close interrupts the rest of this write.
	n, err := c.Conn.Write(data[:6])
	if err != nil {
		return n, err
	}
	close(c.entered)
	<-c.closed
	close(c.finished)
	return n, net.ErrClosed
}

func (c *partialGuestWrite) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

func startBlockedManagedQEMU(t *testing.T) (GvproxyConfig, int64, *partialGuestWrite) {
	t.Helper()
	cfg := managedSocketConfig(t)
	writer := &partialGuestWrite{entered: make(chan struct{}), closed: make(chan struct{}), finished: make(chan struct{})}
	id, err := startGvproxyOnTransport(cfg, &managedNetworkStartup{}, types.QemuProtocol, func(conn net.Conn) net.Conn {
		writer.Conn = conn
		return writer
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { destroyGvproxy(id) })
	guest, err := net.Dial("unix", cfg.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guest.Close() })
	tap := &guestTap{conn: guest, frames: make(chan []byte, 8)}
	go tap.readLoop()
	upstream, port := listenUDP(t)
	if err := upstream.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatal(err)
	}
	tap.send(t, udpFrame(t, cfg.HostIP, port, []byte("managed UDP request")))
	var data [64]byte
	_, peer, err := upstream.ReadFrom(data[:])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := upstream.WriteTo([]byte(heldReplyPayload), peer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writer.entered:
	case <-time.After(forwardWindow):
		t.Fatal("managed UDP reply did not enter the final socket write")
	}
	return cfg, id, writer
}

func TestManagedQEMUPartialWriteBlocksBindAndRetry(t *testing.T) {
	cfg, _, writer := startBlockedManagedQEMU(t)
	client := managedBindingClient(t, cfg)
	bind := func() string {
		t.Helper()
		status, body := bindManagedRoute(t, client)
		if status != http.StatusInternalServerError {
			t.Fatalf("obstructed bind got HTTP %d, %q", status, body)
		}
		return body
	}
	if body := bind(); !strings.Contains(body, context.DeadlineExceeded.Error()) {
		t.Fatalf("first bind did not wait for the obstructed write: %s", body)
	}
	_ = writer.Close()
	if body := bind(); !strings.Contains(body, errUDPGuestLinkUncertain.Error()) {
		t.Fatalf("retry did not reject the damaged stream: %s", body)
	}
}

func managedBindingClient(t *testing.T, cfg GvproxyConfig) *http.Client {
	t.Helper()
	dialer := &net.Dialer{}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", cfg.ControlSocketPath)
	}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: udpCutoverTimeout + 3*time.Second}
}

func bindManagedRoute(t *testing.T, client *http.Client) (int, string) {
	t.Helper()
	const update = `{"mode":"enabled","proxy_route":{"scheme":"https","host":"8.8.8.8","port":443,"doh_url":"https://cloudflare-dns.com/dns-query","doh_address":"1.1.1.1:443"}}`
	request, err := http.NewRequest(http.MethodPut, "http://localhost"+outboundSnapshotPath, strings.NewReader(update))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("If-Match", outboundETag("startup"))
	request.Header.Set(outboundRevisionHeader, "candidate")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(body)
}

func TestManagedQEMUShutdownJoinsAnObstructedWrite(t *testing.T) {
	_, id, writer := startBlockedManagedQEMU(t)
	done := make(chan bool, 1)
	go func() { done <- destroyGvproxy(id) }()
	select {
	case destroyed := <-done:
		if !destroyed {
			t.Fatal("managed instance was not destroyed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("managed shutdown waited for the guest to read the rest of the frame")
	}
	select {
	case <-writer.finished:
	default:
		t.Fatal("destroy returned before the obstructed write exited")
	}
}

const bufferedReplyPayload = "UDP reply delivered before bind"

type completedGuestWrite struct {
	net.Conn
	written chan<- struct{}
}

func (c completedGuestWrite) Write(frame []byte) (int, error) {
	n, err := c.Conn.Write(frame)
	if err == nil && n == len(frame) && bytes.HasSuffix(frame, []byte(bufferedReplyPayload)) {
		close(c.written)
	}
	return n, err
}

// The guest helpers send QEMU length prefixes. Strip that prefix for VFKit.
type datagramGuest struct{ net.Conn }

func (g datagramGuest) Write(frame []byte) (int, error) {
	n, err := g.Conn.Write(frame[4:])
	return n + 4, err
}

func TestManagedGuestReadsBeforeAckHandoffAfterBind(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		t.Run(string(protocol), func(t *testing.T) {
			if protocol == types.VfkitProtocol && runtime.GOOS != "darwin" {
				t.Skip("VFKit Unix datagram transport requires macOS")
			}
			cfg := managedSocketConfig(t)
			written := make(chan struct{})
			id, err := startGvproxyOnTransport(cfg, &managedNetworkStartup{}, protocol, func(conn net.Conn) net.Conn {
				return completedGuestWrite{Conn: conn, written: written}
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { destroyGvproxy(id) })
			guest := dialManagedGuest(t, cfg, protocol)
			t.Cleanup(func() { _ = guest.Close() })
			tap := &guestTap{conn: guest}
			upstream, port := listenUDP(t)
			if err := upstream.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
				t.Fatal(err)
			}
			tap.send(t, udpFrame(t, cfg.HostIP, port, []byte("managed UDP request")))
			var data [64]byte
			_, peer, err := upstream.ReadFrom(data[:])
			if err != nil {
				t.Fatal(err)
			}
			if _, err := upstream.WriteTo([]byte(bufferedReplyPayload), peer); err != nil {
				t.Fatal(err)
			}
			if !tap.answerARP(readManagedGuestFrame(t, guest, protocol)) {
				t.Fatal("guest did not receive the link's ARP request")
			}
			select {
			case <-written:
			case <-time.After(forwardWindow):
				t.Fatal("UDP frame was not handed to the host socket")
			}
			if status, body := bindManagedRoute(t, managedBindingClient(t, cfg)); status != http.StatusOK {
				t.Fatalf("bind after full socket handoff got HTTP %d, %q", status, body)
			}
			if frame := readManagedGuestFrame(t, guest, protocol); !bytes.HasSuffix(frame, []byte(bufferedReplyPayload)) {
				t.Fatal("guest did not read the frame buffered before binding")
			}
		})
	}
}

func dialManagedGuest(t *testing.T, cfg GvproxyConfig, protocol types.Protocol) net.Conn {
	t.Helper()
	if protocol == types.VfkitProtocol {
		local := &net.UnixAddr{Name: filepath.Join(filepath.Dir(cfg.SocketPath), "peer"), Net: "unixgram"}
		remote := &net.UnixAddr{Name: cfg.SocketPath, Net: "unixgram"}
		guest, err := net.DialUnix("unixgram", local, remote)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := guest.Write([]byte("VFKT")); err != nil {
			_ = guest.Close()
			t.Fatal(err)
		}
		return datagramGuest{Conn: guest}
	}
	guest, err := net.Dial("unix", cfg.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	return guest
}

func readManagedGuestFrame(t *testing.T, guest net.Conn, protocol types.Protocol) []byte {
	t.Helper()
	if err := guest.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatal(err)
	}
	if protocol == types.VfkitProtocol {
		data := make([]byte, 2048)
		n, err := guest.Read(data)
		if err != nil {
			t.Fatal(err)
		}
		return data[:n]
	}
	var size [4]byte
	if _, err := io.ReadFull(guest, size[:]); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, binary.BigEndian.Uint32(size[:]))
	if _, err := io.ReadFull(guest, data); err != nil {
		t.Fatal(err)
	}
	return data
}
