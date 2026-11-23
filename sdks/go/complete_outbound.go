//go:build unix

package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"encoding/json"
	"runtime"
	"unsafe"
)

// EffectiveOutboundPolicy always carries both lists.
type EffectiveOutboundPolicy struct {
	Mode     NetworkMode `json:"mode"`
	AllowNet []string    `json:"allow_net"`
	DenyNet  []string    `json:"deny_net"`
}

type OutboundAdmission string

const (
	OutboundAdmissionLegacy            OutboundAdmission = "legacy"
	OutboundAdmissionExtendedIPv4      OutboundAdmission = "extended_ipv4"
	OutboundAdmissionExtendedDualStack OutboundAdmission = "extended_dual_stack"
)

type OutboundIPv6Link struct {
	Interface string `json:"interface"`
	Guest     string `json:"guest"`
	Gateway   string `json:"gateway"`
}

type CompleteOutboundSnapshot struct {
	Policy    EffectiveOutboundPolicy `json:"policy"`
	Revision  string                  `json:"revision"`
	Admission OutboundAdmission       `json:"admission"`
	IPv6      *OutboundIPv6Link       `json:"ipv6,omitempty"`
}

// CompleteOutboundPolicy preserves a nil DenyNet as omitted and a non-nil
// empty DenyNet as an explicit clear.
type CompleteOutboundPolicy struct {
	Mode     NetworkMode `json:"mode"`
	AllowNet []string    `json:"allow_net,omitempty"`
	DenyNet  []string    `json:"deny_net,omitzero"`
}

type PreparedOutboundCreate struct {
	Snapshot    CompleteOutboundSnapshot `json:"snapshot"`
	DenyPresent bool                     `json:"deny_present"`
	RebuildPin  string                   `json:"rebuild_pin,omitempty"`
}

type HostedOutboundReceipt struct {
	Outcome    string                    `json:"outcome"`
	Candidate  *PreparedOutboundCreate   `json:"candidate,omitempty"`
	Snapshot   *CompleteOutboundSnapshot `json:"snapshot,omitempty"`
	RebuildPin string                    `json:"rebuild_pin,omitempty"`
}

// HostedOutbound forwards an authenticated Runner command without losing field presence.
func (n *Network) HostedOutbound(ctx context.Context, command json.RawMessage) (HostedOutboundReceipt, error) {
	var receipt HostedOutboundReceipt
	if !json.Valid(command) {
		return receipt, &Error{Code: ErrInvalidArgument, Message: "invalid hosted outbound command"}
	}
	input := C.CString(string(command))
	defer C.free(unsafe.Pointer(input))
	err := n.readNetworkJSON(ctx, &receipt, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_hosted_outbound(handle, input, value, failure)
	})
	return receipt, err
}

type CompleteOutboundObservation struct {
	Snapshot         CompleteOutboundSnapshot `json:"snapshot"`
	ApplicationState OutboundApplicationState `json:"application_state"`
}

type CompleteOutboundStatus struct {
	Persisted        CompleteOutboundSnapshot     `json:"persisted"`
	Observed         *CompleteOutboundObservation `json:"observed"`
	ApplicationState OutboundApplicationState     `json:"application_state"`
	PendingRevision  string                       `json:"pending_revision,omitempty"`
	ObservationError string                       `json:"observation_error,omitempty"`
}

type OutboundPolicyStatus struct {
	Persisted        *CompleteOutboundSnapshot    `json:"persisted"`
	RuntimePersisted *CompleteOutboundSnapshot    `json:"runtime_persisted"`
	Observed         *CompleteOutboundObservation `json:"observed"`
	ApplicationState OutboundApplicationState     `json:"application_state"`
	PendingRevision  string                       `json:"pending_revision,omitempty"`
	ObservationError string                       `json:"observation_error,omitempty"`
}

type OutboundPolicyReplacement struct {
	Acknowledged        CompleteOutboundSnapshot `json:"acknowledged"`
	Status              *OutboundPolicyStatus    `json:"status"`
	ApplicationVerified bool                     `json:"application_verified"`
	StatusError         string                   `json:"status_error"`
}

// OutboundPolicyStatus reads complete Cloud or native policy without changing it.
func (n *Network) OutboundPolicyStatus(ctx context.Context) (OutboundPolicyStatus, error) {
	var result OutboundPolicyStatus
	err := n.readNetworkJSON(ctx, &result, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_outbound_policy_status(handle, value, failure)
	})
	return result, err
}

// ReplaceOutboundPolicy fences expected or, if empty, the committed revision
// before it writes. The returned status is separate evidence of application.
func (n *Network) ReplaceOutboundPolicy(ctx context.Context, policy CompleteOutboundPolicy, expected string) (OutboundPolicyReplacement, error) {
	var result OutboundPolicyReplacement
	if expected != "" && !ValidOutboundRevision(expected) {
		return result, &Error{Code: ErrInvalidArgument, Message: "invalid expected outbound revision"}
	}
	body, err := json.Marshal(policy)
	if err != nil {
		return result, err
	}
	cPolicy := C.CString(string(body))
	defer C.free(unsafe.Pointer(cPolicy))
	var revision *C.char
	if expected != "" {
		revision = C.CString(expected)
		defer C.free(unsafe.Pointer(revision))
	}
	err = n.readNetworkJSON(ctx, &result, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_replace_outbound_policy(handle, revision, cPolicy, value, failure)
	})
	return result, err
}

// The native ABI flattens the observed snapshot into the observation object.
// Decode that wire format here so Go and Runner callers receive their typed shape.
type nativeCompleteOutboundStatus struct {
	Persisted CompleteOutboundSnapshot `json:"persisted"`
	Observed  *struct {
		CompleteOutboundSnapshot
		ApplicationState OutboundApplicationState `json:"application_state"`
	} `json:"observed"`
	ApplicationState OutboundApplicationState `json:"application_state"`
	PendingRevision  string                   `json:"pending_revision"`
	ObservationError string                   `json:"observation_error"`
}

// PrepareOutboundCreate lets the Runtime validate the original wire fields.
// In particular, a null deny_net cannot be treated as an omitted field.
func (r *Runtime) PrepareOutboundCreate(ctx context.Context, revision string, policy json.RawMessage) (PreparedOutboundCreate, error) {
	var result PreparedOutboundCreate
	if r == nil {
		return result, ErrRuntimeClosed
	}
	r.nativeCallMu.Lock()
	defer r.nativeCallMu.Unlock()
	if r.handle == nil {
		return result, ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if !ValidOutboundRevision(revision) || revision == "initial" || !json.Valid(policy) {
		return result, &Error{Code: ErrInvalidArgument, Message: "invalid outbound create revision or policy"}
	}
	cRevision := C.CString(revision)
	cPolicy := C.CString(string(policy))
	defer C.free(unsafe.Pointer(cRevision))
	defer C.free(unsafe.Pointer(cPolicy))
	defer runtime.KeepAlive(r)
	var value *C.char
	var failure C.CBoxliteError
	code := C.boxlite_runtime_prepare_outbound_create(r.handle, cRevision, cPolicy, &value, &failure)
	defer C.boxlite_free_string(value)
	if code != C.Ok {
		return result, freeError(&failure)
	}
	if value == nil {
		return result, &Error{Code: ErrNetwork, Message: "prepared outbound response is missing"}
	}
	err := json.Unmarshal([]byte(C.GoString(value)), &result)
	return result, err
}

func (n *Network) CompleteOutboundSnapshot(ctx context.Context) (CompleteOutboundSnapshot, error) {
	var result CompleteOutboundSnapshot
	err := n.readNetworkJSON(ctx, &result, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_complete_outbound_snapshot(handle, value, failure)
	})
	return result, err
}

func (n *Network) CompleteOutboundStatus(ctx context.Context) (CompleteOutboundStatus, error) {
	var native nativeCompleteOutboundStatus
	err := n.readNetworkJSON(ctx, &native, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_complete_outbound_status(handle, value, failure)
	})
	if err != nil {
		return CompleteOutboundStatus{}, err
	}
	result := CompleteOutboundStatus{
		Persisted:        native.Persisted,
		ApplicationState: native.ApplicationState,
		PendingRevision:  native.PendingRevision,
		ObservationError: native.ObservationError,
	}
	if observed := native.Observed; observed != nil {
		result.Observed = &CompleteOutboundObservation{
			Snapshot:         observed.CompleteOutboundSnapshot,
			ApplicationState: observed.ApplicationState,
		}
	}
	return result, nil
}
