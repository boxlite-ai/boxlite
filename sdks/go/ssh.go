package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/cgo"
	"sync"
	"unsafe"
)

type SSHCAConfig struct {
	PublicKey string `json:"public_key"`
	Principal string `json:"principal"`
}
type SSHAccount struct {
	Login          string       `json:"login"`
	AuthorizedKeys []string     `json:"authorized_keys"`
	CA             *SSHCAConfig `json:"ca,omitempty"`
}
type SSHConfig struct {
	ListenAddress  string       `json:"listen_address"`
	HostPrivateKey string       `json:"host_private_key"`
	Accounts       []SSHAccount `json:"accounts"`
}
type SSHStatus struct {
	Enabled            bool   `json:"enabled"`
	Generation         uint64 `json:"generation"`
	ListenAddress      string `json:"listen_address"`
	HostPublicKey      string `json:"host_public_key"`
	HostKeyFingerprint string `json:"host_key_fingerprint"`
}

func (c SSHConfig) String() string     { return "SSHConfig{credentials: [REDACTED]}" }
func (c SSHConfig) GoString() string   { return c.String() }
func (c SSHAccount) String() string    { return "SSHAccount{credentials: [REDACTED]}" }
func (c SSHAccount) GoString() string  { return c.String() }
func (c SSHCAConfig) String() string   { return "SSHCAConfig{credentials: [REDACTED]}" }
func (c SSHCAConfig) GoString() string { return c.String() }

// SSH owns a control handle. Close releases it without disabling the listener.
type SSH struct {
	mu      sync.RWMutex
	handle  *C.CSshHandle
	runtime *Runtime
}
type sshResult struct {
	value *SSHStatus
	err   error
}

func (b *Box) SSH() (*SSH, error) {
	if b == nil || b.handle == nil {
		return nil, ErrRuntimeClosed
	}
	var handle *C.CSshHandle
	var cerr C.CBoxliteError
	if C.boxlite_box_ssh(b.handle, &handle, &cerr) != C.Ok {
		return nil, freeError(&cerr)
	}
	return &SSH{handle: handle, runtime: b.runtime}, nil
}

func (s *SSH) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handle != nil {
		C.boxlite_ssh_free(s.handle)
		s.handle = nil
	}
	return nil
}

// Configure replaces all credentials and restarts SSH. Cancellation does not roll back changes.
func (s *SSH) Configure(ctx context.Context, config SSHConfig) (*SSHStatus, error) {
	// A nil key list means no plain keys (a CA-only account is valid).
	config.Accounts = append([]SSHAccount{}, config.Accounts...)
	for i := range config.Accounts {
		if config.Accounts[i].AuthorizedKeys == nil {
			config.Accounts[i].AuthorizedKeys = []string{}
		}
	}
	body, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("encode SSH configuration: %w", err)
	}
	return s.call(ctx, "configure", body)
}
func (s *SSH) Status(ctx context.Context) (*SSHStatus, error)  { return s.call(ctx, "status", nil) }
func (s *SSH) Disable(ctx context.Context) (*SSHStatus, error) { return s.call(ctx, "disable", nil) }

func (s *SSH) call(ctx context.Context, operation string, body []byte) (*SSHStatus, error) {
	if s == nil {
		return nil, ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	if s.handle == nil {
		s.mu.RUnlock()
		return nil, ErrRuntimeClosed
	}
	select {
	case <-s.runtime.closing:
		s.mu.RUnlock()
		return nil, ErrRuntimeClosed
	default:
	}
	s.runtime.ensureDrainRunning()
	ch := make(chan sshResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	switch operation {
	case "configure":
		config := C.CString(string(body))
		code = C.boxlite_ssh_configure(s.handle, config, C.cbSsh(), handleToPtr(h), &cerr)
		C.free(unsafe.Pointer(config))
	case "status":
		code = C.boxlite_ssh_status(s.handle, C.cbSsh(), handleToPtr(h), &cerr)
	case "disable":
		code = C.boxlite_ssh_disable(s.handle, C.cbSsh(), handleToPtr(h), &cerr)
	}
	s.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}
	select {
	case result := <-ch:
		return result.value, result.err
	case <-ctx.Done():
		drainAndDelete(ch, h, s.runtime.closing)
		return nil, ctx.Err()
	case <-s.runtime.closing:
		drainAndDelete(ch, h, s.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}
