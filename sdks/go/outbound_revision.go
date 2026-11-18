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

// OutboundPolicy is the complete wire policy, separate from control metadata.
type OutboundPolicy struct {
	Mode     NetworkMode `json:"mode"`
	AllowNet []string    `json:"allow_net"`
}

// OutboundSnapshot identifies durable policy; it alone does not confirm live state.
type OutboundSnapshot struct {
	Policy   OutboundPolicy `json:"policy"`
	Revision string         `json:"revision"`
}

type OutboundApplicationState string

const (
	OutboundPending   OutboundApplicationState = "pending"
	OutboundConfirmed OutboundApplicationState = "confirmed"
	OutboundUncertain OutboundApplicationState = "uncertain"
)

// OutboundSnapshotStatus describes one observed backend snapshot.
type OutboundSnapshotStatus struct {
	OutboundSnapshot
	ApplicationState OutboundApplicationState `json:"application_state"`
}

// OutboundStatus compares durable intent with completed or uncertain live state.
type OutboundStatus struct {
	Persisted        OutboundSnapshot         `json:"persisted"`
	Observed         *OutboundSnapshotStatus  `json:"observed"`
	ApplicationState OutboundApplicationState `json:"application_state"`
	PendingRevision  string                   `json:"pending_revision,omitempty"`
	ObservationError string                   `json:"observation_error,omitempty"`
}

// OutboundReplaceOutcome must be checked even when the returned error is nil.
type OutboundReplaceOutcome string

const (
	OutboundApplied            OutboundReplaceOutcome = "applied"
	OutboundPreconditionFailed OutboundReplaceOutcome = "precondition_failed"
)

// OutboundSnapshot reads durable policy and revision without starting a VM.
func (n *Network) OutboundSnapshot(ctx context.Context) (OutboundSnapshot, error) {
	var result OutboundSnapshot
	err := n.readOutbound(ctx, &result, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_outbound_snapshot(handle, value, failure)
	})
	return result, err
}

// OutboundStatus reads comparison status without waiting for a pending policy writer.
// Cancellation is checked before the blocking native call, as with UpdateOutbound.
func (n *Network) OutboundStatus(ctx context.Context) (OutboundStatus, error) {
	var result OutboundStatus
	err := n.readOutbound(ctx, &result, func(handle *C.CBoxNetworkHandle, value **C.char, failure *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_network_outbound_status(handle, value, failure)
	})
	return result, err
}

func (n *Network) readOutbound(ctx context.Context, result any, read func(*C.CBoxNetworkHandle, **C.char, *C.CBoxliteError) C.enum_BoxliteErrorCode) error {
	if n == nil {
		return ErrRuntimeClosed
	}
	n.mu.RLock()
	defer n.mu.RUnlock()
	if n.handle == nil {
		return ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var value *C.char
	var failure C.CBoxliteError
	defer runtime.KeepAlive(n)
	code := read(n.handle, &value, &failure)
	defer C.boxlite_free_string(value)
	if code != C.Ok {
		return freeError(&failure)
	}
	if value == nil {
		return &Error{Code: ErrNetwork, Message: "outbound response is missing"}
	}
	return json.Unmarshal([]byte(C.GoString(value)), result)
}

// ReplaceOutboundSnapshot applies a trusted coordinator's complete candidate.
// The coordinator allocates a fresh Box-scoped revision once and preserves it end to end.
// A rejected precondition is a distinct outcome; errors can leave application uncertain.
func (n *Network) ReplaceOutboundSnapshot(ctx context.Context, expected string, candidate OutboundSnapshot) (OutboundReplaceOutcome, error) {
	if n == nil {
		return "", ErrRuntimeClosed
	}
	n.mu.RLock()
	defer n.mu.RUnlock()
	if n.handle == nil {
		return "", ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !ValidOutboundRevision(expected) || !ValidOutboundRevision(candidate.Revision) || candidate.Revision == "initial" || candidate.Revision == expected {
		return "", &Error{Code: ErrInvalidArgument, Message: "invalid outbound revision precondition or candidate"}
	}
	if candidate.Policy.Mode == "" {
		candidate.Policy.Mode = NetworkModeEnabled
	}
	if candidate.Policy.AllowNet == nil {
		candidate.Policy.AllowNet = []string{}
	}
	body, err := json.Marshal(candidate.Policy)
	if err != nil {
		return "", err
	}
	previous := C.CString(expected)
	revision := C.CString(candidate.Revision)
	policy := C.CString(string(body))
	defer C.free(unsafe.Pointer(previous))
	defer C.free(unsafe.Pointer(revision))
	defer C.free(unsafe.Pointer(policy))
	defer runtime.KeepAlive(n)
	var applied C.uint8_t
	var failure C.CBoxliteError
	if C.boxlite_network_replace_outbound_snapshot(n.handle, previous, revision, policy, &applied, &failure) != C.Ok {
		return "", freeError(&failure)
	}
	if applied == 1 {
		return OutboundApplied, nil
	}
	return OutboundPreconditionFailed, nil
}

// ValidOutboundRevision checks the shared opaque-token grammar without I/O.
func ValidOutboundRevision(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for i := range len(value) {
		c := value[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
