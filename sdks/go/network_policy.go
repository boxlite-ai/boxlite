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

// UpdateInbound replaces inbound policy. A non-empty AllowNet is unsupported.
func (n *Network) UpdateInbound(ctx context.Context, spec InboundNetworkSpec) error {
	if spec.Mode == "" {
		spec.Mode = NetworkModeDisabled
	}
	return n.setPolicy(ctx, spec.Mode, spec.AllowNet, true)
}

// UpdateOutbound replaces outbound policy and its entire allowlist.
// Enabled with no AllowNet clears restrictions. Like Tunnel, cancellation is
// checked before the blocking native call; a timeout can leave an applied policy.
func (n *Network) UpdateOutbound(ctx context.Context, spec OutboundNetworkSpec) error {
	if spec.Mode == "" {
		spec.Mode = NetworkModeEnabled
	}
	return n.setPolicy(ctx, spec.Mode, spec.AllowNet, false)
}

func (n *Network) setPolicy(ctx context.Context, mode NetworkMode, rules []string, inbound bool) error {
	if n == nil {
		return ErrRuntimeClosed
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.handle == nil {
		return ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if rules == nil {
		rules = []string{}
	}
	body, err := json.Marshal(struct {
		Mode     NetworkMode `json:"mode"`
		AllowNet []string    `json:"allow_net"`
	}{mode, rules})
	if err != nil {
		return err
	}
	encoded := C.CString(string(body))
	defer C.free(unsafe.Pointer(encoded))
	defer runtime.KeepAlive(n)
	var cerr C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	if inbound {
		code = C.boxlite_network_update_inbound(n.handle, encoded, &cerr)
	} else {
		code = C.boxlite_network_update_outbound(n.handle, encoded, &cerr)
	}
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}
