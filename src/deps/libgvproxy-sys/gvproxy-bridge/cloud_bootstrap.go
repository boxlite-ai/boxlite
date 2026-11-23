package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"runtime"
	"time"

	"golang.org/x/sys/unix"
)

// This payload comes from the host Runtime through the shim's private FFI.
type cloudBootstrap struct {
	InventoryDirectory string `json:"inventory_directory"`
	ShimSocket         string `json:"shim_socket"`
	Box                string `json:"box"`
	Instance           string `json:"instance"`
	Revision           string `json:"revision"`
	Digest             string `json:"digest"`
}

func (b *cloudBootstrap) validate() error {
	if runtime.GOOS != "linux" || !filepath.IsAbs(b.InventoryDirectory) || !filepath.IsAbs(b.ShimSocket) ||
		!validOutboundRevision(b.Box) || !validOutboundRevision(b.Instance) || !validOutboundRevision(b.Revision) {
		return fmt.Errorf("Cloud guard requires a Linux host with a private launch identity")
	}
	if digest, err := hex.DecodeString(b.Digest); err != nil || len(digest) != 32 {
		return fmt.Errorf("invalid Cloud inventory digest")
	}
	return nil
}

func (b *cloudBootstrap) hostOperation(ctx context.Context, operation string, guest *net.UnixConn) error {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "unixpacket", b.ShimSocket)
	if err != nil {
		return fmt.Errorf("connect to Cloud guard service: %w", err)
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	request, err := json.Marshal(struct {
		Operation string `json:"operation"`
		Box       string `json:"box"`
		Instance  string `json:"instance"`
	}{operation, b.Box, b.Instance})
	if err != nil {
		return err
	}
	var rights []byte
	if guest != nil {
		raw, err := guest.SyscallConn()
		if err != nil {
			return err
		}
		var fd int
		var dupErr error
		if err := raw.Control(func(value uintptr) {
			fd, dupErr = unix.FcntlInt(value, unix.F_DUPFD_CLOEXEC, 0)
		}); err != nil {
			return err
		}
		if dupErr != nil {
			return dupErr
		}
		defer unix.Close(fd)
		rights = unix.UnixRights(fd)
	}
	if _, _, err := conn.(*net.UnixConn).WriteMsgUnix(request, rights, nil); err != nil {
		return err
	}
	reply := make([]byte, 4096)
	size, _, flags, _, err := conn.(*net.UnixConn).ReadMsgUnix(reply, nil)
	if err != nil || flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 {
		return fmt.Errorf("read Cloud guard service confirmation")
	}
	var proof struct {
		Instance         string `json:"instance"`
		Revision         string `json:"revision"`
		Digest           string `json:"digest"`
		Cgroup           uint64 `json:"cgroup_id"`
		Deadline         uint64 `json:"deadline_ns"`
		InventoryVersion int    `json:"inventory_version"`
		Error            string `json:"error"`
	}
	if err := json.Unmarshal(reply[:size], &proof); err != nil || proof.Error != "" {
		return fmt.Errorf("Cloud guard service rejected %s", operation)
	}
	if operation == "check" || operation == "check_dual_stack" {
		var clock unix.Timespec
		if proof.Instance != b.Instance || proof.Revision != b.Revision || proof.Digest != b.Digest ||
			(operation == "check_dual_stack" && proof.InventoryVersion != 2) ||
			proof.Cgroup == 0 || unix.ClockGettime(unix.CLOCK_MONOTONIC, &clock) != nil ||
			proof.Deadline <= uint64(clock.Sec)*1_000_000_000+uint64(clock.Nsec) {
			return fmt.Errorf("Cloud guard service confirmation does not match the launch identity")
		}
	}
	return nil
}

func (config *GvproxyConfig) prepareGuard() error {
	var directory string
	if bootstrap := config.CloudGuard; bootstrap != nil {
		if err := bootstrap.validate(); err != nil {
			return err
		}
		directory = bootstrap.InventoryDirectory
	}
	guard, err := compilePlatformGuard(config.PlatformProtectedCIDRs, config.CloudGuard != nil, config.Subnet)
	if err != nil {
		return err
	}
	config.guard, config.cloudInventoryDirectory = guard, directory
	return nil
}
