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
	"strings"
	"unsafe"
)

// OutboundProxy is the public projection of an organization registration.
type OutboundProxy struct {
	Name                 string `json:"name"`
	URL                  string `json:"url"`
	Revision             uint64 `json:"revision"`
	CredentialConfigured bool   `json:"credential_configured"`
}

// ProxyCredential is write-only. Use NewProxyCredential to validate its fields.
type ProxyCredential struct{ username, password string }

func NewProxyCredential(username, password string) (*ProxyCredential, error) {
	for _, field := range []string{username, password} {
		if len(field) == 0 || len(field) > 255 || strings.ContainsFunc(field, func(r rune) bool { return r < ' ' || r > '~' }) {
			return nil, fmt.Errorf("boxlite: proxy credentials require 1 to 255 printable ASCII characters per field")
		}
	}
	return &ProxyCredential{username, password}, nil
}

func (ProxyCredential) String() string     { return "ProxyCredential{[redacted]}" }
func (c ProxyCredential) GoString() string { return c.String() }

// ProxyUpdate preserves omitted fields. Set ClearCredential to clear a login.
type ProxyUpdate struct {
	URL             *string
	Credential      *ProxyCredential
	ClearCredential bool
}

type ProxyMutationState string

const (
	ProxyRejected                   ProxyMutationState = "rejected"
	ProxyAccepted                   ProxyMutationState = "accepted"
	ProxyUnknown                    ProxyMutationState = "unknown"
	ProxyAcceptedReleaseUnconfirmed ProxyMutationState = "accepted_release_unconfirmed"
)

type ProxyMutation struct {
	State      ProxyMutationState
	HTTPStatus uint16
	Revision   string
}

type ProxyMutationError struct{ Outcome ProxyMutation }

func (e *ProxyMutationError) Error() string {
	return fmt.Sprintf("boxlite: proxy change %s (HTTP %d)", e.Outcome.State, e.Outcome.HTTPStatus)
}

func proxyOutcome(value C.struct_CProxyMutation) ProxyMutation {
	defer C.boxlite_free_string(value.revision)
	outcome := ProxyMutation{HTTPStatus: uint16(value.http_status)}
	switch value.state {
	case C.ProxyRejected:
		outcome.State = ProxyRejected
	case C.ProxyAccepted:
		outcome.State = ProxyAccepted
	case C.ProxyAcceptedReleaseUnconfirmed:
		outcome.State = ProxyAcceptedReleaseUnconfirmed
	default:
		outcome.State = ProxyUnknown
	}
	if value.revision != nil {
		outcome.Revision = C.GoString(value.revision)
	}
	return outcome
}

func proxyMutationResult(code C.enum_BoxliteErrorCode, failure *C.CBoxliteError, value C.struct_CProxyMutation) (ProxyMutation, error) {
	outcome := proxyOutcome(value)
	if code != C.Ok {
		return outcome, freeError(failure)
	}
	if outcome.State == ProxyUnknown || outcome.State == ProxyRejected {
		return outcome, &ProxyMutationError{Outcome: outcome}
	}
	return outcome, nil
}

// The native proxy operations are blocking. Cancellation is checked before I/O.
func (r *Runtime) lockProxyRuntime(ctx context.Context) (func(), error) {
	if r == nil {
		return nil, ErrRuntimeClosed
	}
	r.proxyMu.RLock()
	if r.handle == nil {
		r.proxyMu.RUnlock()
		return nil, ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		r.proxyMu.RUnlock()
		return nil, err
	}
	return r.proxyMu.RUnlock, nil
}

func optionalProxyCString(value *string) (*C.char, func(), error) {
	if value == nil {
		return nil, func() {}, nil
	}
	if strings.IndexByte(*value, 0) >= 0 {
		return nil, nil, fmt.Errorf("boxlite: proxy argument contains a NUL byte")
	}
	result := C.CString(*value)
	return result, func() { C.free(unsafe.Pointer(result)) }, nil
}

func (r *Runtime) readProxies(ctx context.Context, name *string, result any) error {
	unlock, err := r.lockProxyRuntime(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	cName, freeName, err := optionalProxyCString(name)
	if err != nil {
		return err
	}
	defer freeName()
	var value *C.char
	var failure C.CBoxliteError
	code := C.boxlite_outbound_proxy_read(r.handle, cName, &value, &failure)
	defer C.boxlite_free_string(value)
	if code != C.Ok {
		return freeError(&failure)
	}
	return json.Unmarshal([]byte(C.GoString(value)), result)
}

func (r *Runtime) ListOutboundProxies(ctx context.Context) ([]OutboundProxy, error) {
	var result []OutboundProxy
	err := r.readProxies(ctx, nil, &result)
	return result, err
}

func (r *Runtime) OutboundProxy(ctx context.Context, name string) (OutboundProxy, error) {
	var result OutboundProxy
	err := r.readProxies(ctx, &name, &result)
	return result, err
}

func (r *Runtime) CreateOutboundProxy(ctx context.Context, name, url string, credential *ProxyCredential) (ProxyMutation, error) {
	return r.mutateOutboundProxy(ctx, name, ProxyUpdate{URL: &url, Credential: credential}, "create")
}

func (r *Runtime) UpdateOutboundProxy(ctx context.Context, name string, update ProxyUpdate) (ProxyMutation, error) {
	return r.mutateOutboundProxy(ctx, name, update, "update")
}

func (r *Runtime) DeleteOutboundProxy(ctx context.Context, name string) (ProxyMutation, error) {
	return r.mutateOutboundProxy(ctx, name, ProxyUpdate{}, "delete")
}

func (r *Runtime) mutateOutboundProxy(ctx context.Context, name string, update ProxyUpdate, method string) (ProxyMutation, error) {
	result := ProxyMutation{State: ProxyRejected}
	unlock, err := r.lockProxyRuntime(ctx)
	if err != nil {
		return result, err
	}
	defer unlock()
	cName, freeName, err := optionalProxyCString(&name)
	if err != nil {
		return result, err
	}
	defer freeName()
	cURL, freeURL, err := optionalProxyCString(update.URL)
	if err != nil {
		return result, err
	}
	defer freeURL()
	var username, password *C.char
	if update.Credential != nil {
		if _, err := NewProxyCredential(update.Credential.username, update.Credential.password); err != nil {
			return result, err
		}
		username = C.CString(update.Credential.username)
		password = C.CString(update.Credential.password)
		defer C.free(unsafe.Pointer(username))
		defer C.free(unsafe.Pointer(password))
	}
	var value C.struct_CProxyMutation
	var failure C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	switch method {
	case "create":
		code = C.boxlite_outbound_proxy_create(r.handle, cName, cURL, username, password, &value, &failure)
	case "update":
		var clear C.uint8_t
		if update.ClearCredential {
			clear = 1
		}
		code = C.boxlite_outbound_proxy_update(r.handle, cName, cURL, username, password, clear, &value, &failure)
	default:
		code = C.boxlite_outbound_proxy_delete(r.handle, cName, &value, &failure)
	}
	return proxyMutationResult(code, &failure, value)
}

// SetManagedProxy binds a registration, or requests unbind when name is nil.
func (n *Network) SetManagedProxy(ctx context.Context, name *string) (ProxyMutation, error) {
	result := ProxyMutation{State: ProxyRejected}
	if n == nil {
		return result, ErrRuntimeClosed
	}
	n.mu.RLock()
	defer n.mu.RUnlock()
	if n.handle == nil {
		return result, ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	cName, freeName, err := optionalProxyCString(name)
	if err != nil {
		return result, err
	}
	defer freeName()
	var value C.struct_CProxyMutation
	var failure C.CBoxliteError
	code := C.boxlite_network_set_managed_proxy(n.handle, cName, &value, &failure)
	return proxyMutationResult(code, &failure, value)
}

type ProxyIdentity struct {
	Name     string `json:"name"`
	Revision uint64 `json:"revision"`
}

type ProxyPolicyRevision struct {
	PolicyRevision string         `json:"policy_revision"`
	Proxy          *ProxyIdentity `json:"proxy"`
}

type ManagedProxyStatus struct {
	Revision         string               `json:"revision"`
	ApplicationState string               `json:"application_state"`
	Desired          *ProxyIdentity       `json:"desired"`
	Committed        *ProxyIdentity       `json:"committed"`
	Pending          *ProxyPolicyRevision `json:"pending"`
	Installed        *ProxyPolicyRevision `json:"installed"`
	RuntimeReadback  string               `json:"runtime_readback"`
}

func (n *Network) ManagedProxyStatus(ctx context.Context) (ManagedProxyStatus, error) {
	var result ManagedProxyStatus
	err := n.readOutbound(ctx, &result, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_managed_proxy_status(handle, value, failure)
	})
	return result, err
}

type ManagedCreateAdmission string

const (
	ManagedCreateRejected ManagedCreateAdmission = "rejected"
	ManagedCreateAdmitted ManagedCreateAdmission = "admitted"
	ManagedCreateUnknown  ManagedCreateAdmission = "unknown"
)

type ManagedCreateError struct {
	Admission  ManagedCreateAdmission
	HTTPStatus uint16
	BoxID      string
	Cause      error
}

func (e *ManagedCreateError) Error() string {
	return fmt.Sprintf("boxlite: managed Box create %s (HTTP %d, Box %q): %v", e.Admission, e.HTTPStatus, e.BoxID, e.Cause)
}

func (e *ManagedCreateError) Unwrap() error { return e.Cause }

// CreateWithOutboundProxy sends a registration name or explicit null.
// Use Create to omit proxy selection. Check the admission error before another create.
func (r *Runtime) CreateWithOutboundProxy(ctx context.Context, image string, proxy *string, opts ...BoxOption) (*Box, error) {
	unlock, err := r.lockProxyRuntime(ctx)
	if err != nil {
		return nil, err
	}
	defer unlock()
	cfg := &boxConfig{}
	for _, option := range opts {
		option(cfg)
	}
	cOpts, err := buildCOptions(image, cfg)
	if err != nil {
		return nil, err
	}
	defer C.boxlite_options_free(cOpts)
	cName, freeName, err := optionalProxyCString(proxy)
	if err != nil {
		return nil, err
	}
	defer freeName()
	var handle *C.CBoxHandle
	var value C.struct_CManagedCreateOutcome
	var failure C.CBoxliteError
	code := C.boxlite_create_box_with_managed_proxy(r.handle, cOpts, cName, &handle, &value, &failure)
	defer C.boxlite_free_string(value.box_id)
	if code == C.Ok {
		return newBoxFromHandle(r, handle, cfg.name), nil
	}
	admission := ManagedCreateUnknown
	switch value.admission {
	case C.ManagedCreateRejected:
		admission = ManagedCreateRejected
	case C.ManagedCreateAdmitted:
		admission = ManagedCreateAdmitted
	}
	return nil, &ManagedCreateError{Admission: admission, HTTPStatus: uint16(value.http_status), BoxID: C.GoString(value.box_id), Cause: freeError(&failure)}
}
