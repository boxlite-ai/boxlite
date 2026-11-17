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
	"unsafe"
)

// SSH controls a box's guest SSH listener. It refers to its Box, so it stays
// usable until the box is closed and has no Close of its own.
//
// Only Configure may start the box. With an explicit WithCmd or
// WithEntrypoint, a box that is not running fails Configure with
// ErrInvalidState: call Box.Start first. Status, Enable and Disable never start it.
// Canceling a call returns promptly but does not undo a configuration the
// guest has already applied.
type SSH struct {
	box *Box
}

// SSHConfig is the complete guest SSH configuration; Configure replaces the
// previous one. Printing it with %v, %+v, %s or %#v redacts every key.
type SSHConfig struct {
	// ListenAddress is the guest address to bind, such as "0.0.0.0:2222".
	ListenAddress string
	// HostPrivateKey is an unencrypted OpenSSH private key.
	HostPrivateKey string
	Accounts       []SSHAccount
}

// SSHAccount holds the credentials accepted for one SSH login.
type SSHAccount struct {
	Login string
	// AuthorizedKeys are OpenSSH public keys; nil means none.
	AuthorizedKeys []string
	// CA, when set, also accepts certificates it signed for its principal.
	CA *SSHCAConfig
}

// SSHCAConfig is a certificate authority and the principal its certificates
// must name.
type SSHCAConfig struct {
	PublicKey string
	Principal string
}

// SSHStatus is the listener state observed by one call; it carries no
// credentials.
type SSHStatus struct {
	Enabled bool
	// Generation advances on every accepted Configure and survives Disable.
	// A box that is not running reports zero.
	Generation         uint64
	ListenAddress      string
	HostPublicKey      string
	HostKeyFingerprint string
}

// SSHUsageEvent is one accepted authentication, without keys or login names.
type SSHUsageEvent struct {
	ID           string `json:"id"`
	OccurredAtMS uint64 `json:"occurred_at_ms"`
}

// SSHUsageBatch drains the guest's bounded, volatile evidence buffer.
// DroppedTotal counts buffer overflow or contention since guest startup.
type SSHUsageBatch struct {
	Events       []SSHUsageEvent `json:"events"`
	DroppedTotal uint64          `json:"dropped_total"`
}

// TakeUsage reads and removes local guest evidence without starting the box.
// Only an explicit caller reads it; the SDK never sends it to an analytics service.
// A failed or canceled drain may lose evidence. REST runtimes and older guests
// return ErrUnsupported; a stopped or configured local box returns an empty batch.
func (s *SSH) TakeUsage(ctx context.Context) (*SSHUsageBatch, error) {
	if s == nil || s.box == nil || s.box.handle == nil {
		return nil, &Error{Code: ErrInvalidState, Message: "box is closed"}
	}
	rt := s.box.runtime
	select {
	case <-rt.closing:
		return nil, ErrRuntimeClosed
	default:
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rt.ensureDrainRunning()
	result := make(chan handleResult[*C.char], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	var cerr C.CBoxliteError
	code := C.boxlite_box_ssh_take_usage(s.box.handle, C.cbSSHUsage(), handleToPtr(handle), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return nil, freeError(&cerr)
	}
	dispose := func(value *C.char) {
		if value != nil {
			freeBoxliteString(value)
		}
	}
	select {
	case completed := <-result:
		defer dispose(completed.value)
		if completed.err != nil {
			return nil, completed.err
		}
		var batch SSHUsageBatch
		if err := json.Unmarshal([]byte(cString(completed.value)), &batch); err != nil {
			return nil, &Error{Code: ErrInternal, Message: "invalid SSH usage response"}
		}
		return &batch, nil
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return nil, ctx.Err()
	case <-rt.closing:
		abandonOwnedResult(result, handle, dispose)
		return nil, ErrRuntimeClosed
	}
}

func (c SSHConfig) String() string {
	return fmt.Sprintf("SSHConfig{ListenAddress:%q HostPrivateKey:[redacted] Accounts:%v}",
		c.ListenAddress, c.Accounts)
}

func (c SSHConfig) GoString() string { return c.String() }

func (a SSHAccount) String() string {
	ca := "<nil>"
	if a.CA != nil {
		ca = "[redacted]"
	}
	return fmt.Sprintf("SSHAccount{Login:%q AuthorizedKeys:[redacted] CA:%s}", a.Login, ca)
}

func (a SSHAccount) GoString() string { return a.String() }

func (c SSHCAConfig) String() string {
	return "SSHCAConfig{PublicKey:[redacted] Principal:[redacted]}"
}

func (c SSHCAConfig) GoString() string { return c.String() }

// The C API's snake_case body. Unexported so the public types do not carry
// the wire contract. Core rejects null lists, so nil slices become empty.
type sshConfigJSON struct {
	ListenAddress  string           `json:"listen_address"`
	HostPrivateKey string           `json:"host_private_key"`
	Accounts       []sshAccountJSON `json:"accounts"`
}

type sshAccountJSON struct {
	Login          string     `json:"login"`
	AuthorizedKeys []string   `json:"authorized_keys"`
	CA             *sshCAJSON `json:"ca,omitempty"`
}

type sshCAJSON struct {
	PublicKey string `json:"public_key"`
	Principal string `json:"principal"`
}

func encodeSSHConfig(config SSHConfig) ([]byte, error) {
	accounts := make([]sshAccountJSON, 0, len(config.Accounts))
	for _, account := range config.Accounts {
		wire := sshAccountJSON{Login: account.Login, AuthorizedKeys: account.AuthorizedKeys}
		if wire.AuthorizedKeys == nil {
			wire.AuthorizedKeys = []string{}
		}
		if account.CA != nil {
			wire.CA = &sshCAJSON{PublicKey: account.CA.PublicKey, Principal: account.CA.Principal}
		}
		accounts = append(accounts, wire)
	}
	return json.Marshal(sshConfigJSON{
		ListenAddress:  config.ListenAddress,
		HostPrivateKey: config.HostPrivateKey,
		Accounts:       accounts,
	})
}

// SSH returns the box's guest SSH control.
func (b *Box) SSH() *SSH { return &SSH{box: b} }

// Configure validates and applies config, restarting the listener and
// disconnecting existing clients. It may start the box; see SSH.
func (s *SSH) Configure(ctx context.Context, config SSHConfig) (*SSHStatus, error) {
	body, err := encodeSSHConfig(config)
	if err != nil {
		return nil, err
	}
	cBody := C.CString(string(body))
	defer C.free(unsafe.Pointer(cBody))
	return s.call(ctx, func(box *C.CBoxHandle, userData unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_ssh_configure(box, cBody, C.cbSSHConfigure(), userData, cerr)
	})
}

// Enable uses saved configuration on a running box without restarting a healthy
// listener. It requires existing configuration and never starts the box.
// A valid handle to a configured or stopped box returns ErrInvalidState without
// changing saved SSH intent.
func (s *SSH) Enable(ctx context.Context) (*SSHStatus, error) {
	return s.call(ctx, func(box *C.CBoxHandle, userData unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_ssh_enable(box, C.cbSSHEnable(), userData, cerr)
	})
}

// Status reads the listener state without starting the box.
func (s *SSH) Status(ctx context.Context) (*SSHStatus, error) {
	return s.call(ctx, func(box *C.CBoxHandle, userData unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_ssh_status(box, C.cbSSHStatus(), userData, cerr)
	})
}

// Disable stops the listener and disconnects clients on a running box without
// starting it. Repeating it is safe while running. A valid handle to a configured
// or stopped box returns ErrInvalidState without changing saved SSH intent.
// Disable while running to persist the disabled switch.
func (s *SSH) Disable(ctx context.Context) (*SSHStatus, error) {
	return s.call(ctx, func(box *C.CBoxHandle, userData unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_ssh_disable(box, C.cbSSHDisable(), userData, cerr)
	})
}

// call refuses a closed box or runtime before any native call, because the
// native box handle would still send the request after Runtime.Close.
func (s *SSH) call(
	ctx context.Context,
	submit func(*C.CBoxHandle, unsafe.Pointer, *C.CBoxliteError) C.enum_BoxliteErrorCode,
) (*SSHStatus, error) {
	if s == nil || s.box == nil {
		return nil, errBoxClosed
	}
	rt := s.box.runtime
	select {
	case <-rt.closing:
		return nil, ErrRuntimeClosed
	default:
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rt.ensureDrainRunning()

	handle, unlock, err := s.box.acquire()
	if err != nil {
		return nil, err
	}

	ch := make(chan sshStatusResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	if code := submit(handle, handleToPtr(h), &cerr); code != C.Ok {
		unlock()
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}
	unlock()

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, rt.closing)
		return nil, ctx.Err()
	case <-rt.closing:
		drainAndDelete(ch, h, rt.closing)
		return nil, ErrRuntimeClosed
	}
}

func sshStatusFromC(status *C.CSshStatus) SSHStatus {
	return SSHStatus{
		Enabled:            status.enabled != 0,
		Generation:         uint64(status.generation),
		ListenAddress:      cString(status.listen_address),
		HostPublicKey:      cString(status.host_public_key),
		HostKeyFingerprint: cString(status.host_key_fingerprint),
	}
}
