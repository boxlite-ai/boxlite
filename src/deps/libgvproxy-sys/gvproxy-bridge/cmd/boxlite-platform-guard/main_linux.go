//go:build linux

// The host service is independent of Runner and the jailed shim.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
	"github.com/boxlite/gvproxy-bridge/internal/guardkernel"
	"golang.org/x/sys/unix"
)

const maxRequest = 4096

type request struct {
	Operation  string `json:"operation"`
	Box        string `json:"box"`
	Instance   string `json:"instance"`
	DataSocket string `json:"data_socket,omitempty"`
}

type response struct {
	Instance  string `json:"instance,omitempty"`
	Revision  string `json:"revision,omitempty"`
	Digest    string `json:"digest,omitempty"`
	Cgroup    uint64 `json:"cgroup_id,omitempty"`
	Deadline  uint64 `json:"deadline_ns,omitempty"`
	ShimPID   int32  `json:"shim_pid,omitempty"`
	ShimStart uint64 `json:"shim_start,omitempty"`
	Error     string `json:"error,omitempty"`
}

func main() {
	state := flag.String("state-dir", "/run/boxlite-platform-guard", "trusted host state directory")
	m := &manager{
		active: make(map[string]record), retired: make(map[string]struct{}), preparing: make(map[string]struct{}),
		sampler: guardinventory.Sampler{RequireRoot: true},
	}
	flag.StringVar(&m.object, "bpf-object", "/usr/lib/boxlite/deadline.bpf.o", "trusted BPF object")
	flag.StringVar(&m.pins, "pin-dir", "/sys/fs/bpf/boxlite_platform_guard", "BPF pin directory")
	flag.StringVar(&m.cgroups, "cgroup-dir", "/sys/fs/cgroup/boxlite", "Box cgroup parent")
	flag.StringVar(&m.inventory, "inventory-dir", "/etc/boxlite/platform-guard", "operator inventory directory")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, unix.SIGTERM)
	defer cancel()
	if err := run(ctx, *state, m); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, state string, m *manager) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("Cloud guard service requires root")
	}
	unix.Umask(0o077)
	m.records = filepath.Join(state, "records")
	shimDir := filepath.Join(state, "shim")
	for _, dir := range []string{state, m.records, m.pins, shimDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		var info unix.Stat_t
		if err := unix.Lstat(dir, &info); err != nil || info.Mode&unix.S_IFMT != unix.S_IFDIR ||
			info.Mode&0o022 != 0 || info.Uid != 0 {
			return fmt.Errorf("Cloud guard directories must be owned and writable only by root")
		}
	}
	if err := os.Chmod(shimDir, 0o711); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(state, "lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return err
	}
	if err := m.recover(); err != nil {
		return err
	}
	current, err := m.sampler.Sample(ctx, m.inventory)
	m.refresh(current, err)
	runner, err := listen(filepath.Join(state, "control.sock"), "unix", 0o600)
	if err != nil {
		return err
	}
	defer runner.Close()
	shim, err := listen(filepath.Join(shimDir, "endpoint.sock"), "unixpacket", 0o666)
	if err != nil {
		return err
	}
	defer shim.Close()
	done := make(chan error, 2)
	go accept(runner, func(conn *net.UnixConn) response { return m.runner(ctx, conn) }, done)
	go accept(shim, m.shim, done)
	go m.watch(ctx)
	select {
	case <-ctx.Done():
		return nil
	case err := <-done:
		return err
	}
}

func listen(path, network string, mode os.FileMode) (*net.UnixListener, error) {
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("Cloud guard socket path is occupied")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.ListenUnix(network, &net.UnixAddr{Name: path, Net: network})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, mode); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func accept(listener *net.UnixListener, handle func(*net.UnixConn) response, done chan<- error) {
	for {
		conn, err := listener.AcceptUnix()
		if err != nil {
			done <- err
			return
		}
		go func() {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(6 * time.Second))
			result := handle(conn)
			_ = json.NewEncoder(conn).Encode(result)
		}()
	}
}

func requestFrom(raw []byte) (request, error) {
	var result request
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil || decoder.Decode(new(any)) != io.EOF {
		return request{}, fmt.Errorf("invalid Cloud guard request")
	}
	if result.Operation == "ready" && result.Box == "" && result.Instance == "" && result.DataSocket == "" {
		return result, nil
	}
	if !component.MatchString(result.Box) {
		return request{}, fmt.Errorf("invalid Cloud guard request")
	}
	if !component.MatchString(result.Instance) && !(result.Operation == "adopt" && result.Instance == "") {
		return request{}, fmt.Errorf("invalid Cloud guard instance")
	}
	return result, nil
}

func peer(conn *net.UnixConn) (*unix.Ucred, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return nil, err
	}
	var credential *unix.Ucred
	var getErr error
	if err := raw.Control(func(fd uintptr) {
		credential, getErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return nil, err
	}
	return credential, getErr
}

func (m *manager) runner(ctx context.Context, conn *net.UnixConn) response {
	credential, err := peer(conn)
	if err != nil || credential.Uid != 0 {
		return response{Error: "trusted host peer required"}
	}
	raw, err := bufio.NewReaderSize(conn, maxRequest).ReadSlice('\n')
	if err != nil {
		return response{Error: "invalid Cloud guard request"}
	}
	req, err := requestFrom(raw)
	if err != nil {
		return response{Error: err.Error()}
	}
	if req.Operation == "ready" {
		if err := m.checkReadiness(ctx); err != nil {
			return response{Error: err.Error()}
		}
		return response{}
	} else if req.Operation == "prepare" {
		if _, err := m.prepare(ctx, req.Box, req.Instance, req.DataSocket); err != nil {
			return response{Error: err.Error()}
		}
	} else if req.Operation == "release" {
		if err := m.release(req.Box, req.Instance); err != nil {
			return response{Error: err.Error()}
		}
		return response{}
	} else if req.Operation != "status" && req.Operation != "adopt" {
		return response{Error: "unsupported Cloud guard operation"}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var stored record
	if req.Operation == "adopt" {
		var ok bool
		stored, ok = m.active[req.Box]
		if !ok || stored.ShimPID == 0 {
			return response{Error: "no verified live Cloud shim"}
		}
	} else {
		stored, err = m.get(req.Box, req.Instance)
		if err != nil {
			return response{Error: err.Error()}
		}
	}
	deadline, err := m.prove(stored)
	if err != nil {
		return response{Error: err.Error()}
	}
	return proofResponse(stored, deadline)
}

func proofResponse(stored record, deadline uint64) response {
	return response{
		Instance: stored.Instance,
		Revision: stored.Revision, Digest: hex.EncodeToString(stored.Digest[:]),
		Cgroup: stored.Kernel.CgroupID, Deadline: deadline,
		ShimPID: stored.ShimPID, ShimStart: stored.ShimStart,
	}
}

func (m *manager) shim(conn *net.UnixConn) response {
	credential, err := peer(conn)
	if err != nil || credential.Pid <= 0 {
		return response{Error: "verified Box shim required"}
	}
	raw := make([]byte, maxRequest)
	rights := make([]byte, unix.CmsgSpace(4))
	size, count, flags, _, err := conn.ReadMsgUnix(raw, rights)
	if err != nil {
		return response{Error: "invalid Cloud guard message"}
	}
	fds := receivedFDs(rights[:count])
	defer func() {
		for _, fd := range fds {
			_ = unix.Close(fd)
		}
	}()
	if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 {
		return response{Error: "invalid Cloud guard message"}
	}
	req, err := requestFrom(raw[:size])
	if err != nil {
		return response{Error: "invalid Cloud guard message"}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	stored, err := m.get(req.Box, req.Instance)
	if err != nil || !cgroupContains(m.cgroup(req.Box), credential.Pid) {
		return response{Error: "verified Box shim required"}
	}
	start, err := pidStart(credential.Pid)
	if err != nil || (stored.ShimPID != 0 && (stored.ShimPID != credential.Pid || stored.ShimStart != start)) {
		return response{Error: "verified Box shim required"}
	}
	pin := m.pinDir(req.Box)
	switch req.Operation {
	case "check":
		if len(fds) == 0 {
			if deadline, err := m.prove(stored); err == nil {
				return proofResponse(stored, deadline)
			}
		}
	case "revoke":
		if len(fds) == 0 {
			if err := m.revoke(req.Box); err == nil {
				return response{}
			}
		}
	case "register_guest":
		if len(fds) == 1 {
			if _, err := m.prove(stored); err == nil {
				if cookie, err := guestCookie(fds[0], stored.DataSocket); err == nil {
					if err := guardkernel.RegisterGuest(pin, cookie); err == nil {
						stored.ShimPID, stored.ShimStart = credential.Pid, start
						if err := m.store(stored); err == nil {
							m.active[req.Box] = stored
							return response{}
						}
					}
				}
			}
		}
	}
	return response{Error: "Cloud guard rejected the shim operation"}
}

func (m *manager) sameShim(stored record) bool {
	start, err := pidStart(stored.ShimPID)
	return err == nil && start == stored.ShimStart && cgroupContains(m.cgroup(stored.Box), stored.ShimPID)
}

func pidStart(pid int32) (uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	end := bytes.LastIndexByte(data, ')')
	if end == -1 {
		return 0, fmt.Errorf("invalid shim process fingerprint")
	}
	fields := strings.Fields(string(data[end+1:]))
	// /proc/pid/stat field 22 follows the parenthesized command (field 2).
	if len(fields) <= 19 {
		return 0, fmt.Errorf("missing shim process start time")
	}
	return strconv.ParseUint(fields[19], 10, 64)
}

func receivedFDs(control []byte) []int {
	messages, _ := unix.ParseSocketControlMessage(control)
	var fds []int
	for _, message := range messages {
		rights, err := unix.ParseUnixRights(&message)
		if err == nil {
			for _, fd := range rights {
				unix.CloseOnExec(fd)
				fds = append(fds, fd)
			}
		}
	}
	return fds
}

func cgroupContains(directory string, pid int32) bool {
	body, err := os.ReadFile(filepath.Join(directory, "cgroup.procs"))
	if err != nil {
		return false
	}
	target := strconv.FormatInt(int64(pid), 10)
	for _, member := range strings.Fields(string(body)) {
		if member == target {
			return true
		}
	}
	return false
}

func guestCookie(fd int, expectedSocket string) (uint64, error) {
	if typ, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_TYPE); err != nil || typ != unix.SOCK_STREAM {
		return 0, fmt.Errorf("expected Unix stream guest socket")
	}
	address, err := unix.Getsockname(fd)
	socket, ok := address.(*unix.SockaddrUnix)
	if err != nil || !ok || socket.Name != expectedSocket {
		return 0, fmt.Errorf("guest socket does not match the Box record")
	}
	if _, err := unix.Getpeername(fd); err != nil {
		return 0, fmt.Errorf("guest socket is not connected")
	}
	return unix.GetsockoptUint64(fd, unix.SOL_SOCKET, unix.SO_COOKIE)
}
