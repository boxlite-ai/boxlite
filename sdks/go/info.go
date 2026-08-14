package boxlite

/*
#include "bridge.h"
*/
import "C"
import (
	"context"
	"runtime/cgo"
	"time"
	"unsafe"
)

// State represents the lifecycle state of a box.
type State string

// The full set the runtime can report, 1:1 with the core's BoxStatus
// (src/boxlite/src/litebox/state.rs) as the FFI layer spells it
// (sdks/c/src/info.rs). Unknown, Paused and Failed were previously unnameable
// from Go, so callers switching on State silently funnelled them into their
// default branch.
const (
	StateUnknown    State = "unknown"
	StateConfigured State = "configured"
	StateRunning    State = "running"
	StateStopping   State = "stopping"
	StateStopped    State = "stopped"
	StatePaused     State = "paused"
	StateFailed     State = "failed"
)

// PublishedPort is a concrete host publication for a guest service port.
type PublishedPort struct {
	GuestPort int
	HostIP    string
	HostPort  int
	Protocol  PortProtocol
}

// NetworkInfo describes the box network and its resolved local publications.
type NetworkInfo struct {
	Mode     NetworkMode
	AllowNet []string
	// PublishedPorts is nil when this handle does not know the bindings. A
	// non-nil empty slice means that the box has no active publications.
	PublishedPorts []PublishedPort
}

// BoxInfo holds information about a box.
type BoxInfo struct {
	ID         string
	Name       string
	Image      string
	State      State
	Running    bool
	PID        int
	CPUs       int
	MemoryMiB  int
	Network    *NetworkInfo
	AutoStop   uint32
	AutoDelete uint32
	AutoResume bool
	CreatedAt  time.Time
	// StartedAt is when the most recent lifecycle published its PID and Running
	// state. The zero time means no boot was recorded. It is preserved after stop
	// and describes PID whenever PID is nonzero. It does not prove that the
	// asynchronous Container.Start finished or that init ran.
	StartedAt time.Time
}

// Info returns information about the box.
func (b *Box) Info(ctx context.Context) (*BoxInfo, error) {
	b.runtime.ensureDrainRunning()

	ch := make(chan infoResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_info(b.handle, C.cbInfo(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.value != nil && res.value.Name != "" && b.name == "" {
			b.name = res.value.Name
		}
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ctx.Err()
	case <-b.runtime.closing:
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// ListInfo lists all boxes.
func (r *Runtime) ListInfo(ctx context.Context) ([]BoxInfo, error) {
	r.ensureDrainRunning()

	ch := make(chan infoListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_list_info(r.handle, C.cbInfoList(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, r.closing)
		return nil, ctx.Err()
	case <-r.closing:
		drainAndDelete(ch, h, r.closing)
		return nil, ErrRuntimeClosed
	}
}

// GetInfo retrieves info for a box by ID or name without attaching a handle.
func (r *Runtime) GetInfo(ctx context.Context, idOrName string) (*BoxInfo, error) {
	r.ensureDrainRunning()

	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan infoResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_get_info(r.handle, cID, C.cbInfo(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, r.closing)
		return nil, ctx.Err()
	case <-r.closing:
		drainAndDelete(ch, h, r.closing)
		return nil, ErrRuntimeClosed
	}
}

func cBoxInfoToGo(info *C.CBoxInfo) BoxInfo {
	pid := int(info.pid)
	var boxStartedAt time.Time
	if ms := int64(info.started_at); ms > 0 {
		boxStartedAt = time.UnixMilli(ms)
	}
	return BoxInfo{
		ID:         cString(info.id),
		Name:       cString(info.name),
		Image:      cString(info.image),
		State:      State(cString(info.status)),
		Running:    info.running != 0,
		PID:        pid,
		CPUs:       int(info.cpus),
		MemoryMiB:  int(info.memory_mib),
		Network:    cNetworkInfoToGo(info.network),
		AutoStop:   uint32(info.auto_stop),
		AutoDelete: uint32(info.auto_delete),
		AutoResume: info.auto_resume != 0,
		CreatedAt:  time.Unix(int64(info.created_at), 0),

		StartedAt: boxStartedAt,
	}
}

func networkModeFromCValue(mode uint32) NetworkMode {
	switch mode {
	case uint32(C.BoxliteNetworkModeEnabled):
		return NetworkModeEnabled
	case uint32(C.BoxliteNetworkModeDisabled):
		return NetworkModeDisabled
	default:
		return NetworkMode("")
	}
}

func portProtocolFromCValue(protocol uint32) PortProtocol {
	switch protocol {
	case uint32(C.BoxlitePortProtocolTcp):
		return PortProtocolTcp
	case uint32(C.BoxlitePortProtocolUdp):
		return PortProtocolUdp
	default:
		return PortProtocolUnknown
	}
}

func cNetworkInfoToGo(network *C.CNetworkInfo) *NetworkInfo {
	if network == nil {
		return nil
	}

	allowNet := make([]string, 0, int(network.allow_net_count))
	if network.allow_net != nil && network.allow_net_count > 0 {
		for _, host := range unsafe.Slice(network.allow_net, int(network.allow_net_count)) {
			allowNet = append(allowNet, cString(host))
		}
	}

	var publishedPorts []PublishedPort
	if network.published_ports != nil {
		ports := network.published_ports
		publishedPorts = make([]PublishedPort, 0, int(ports.count))
		if ports.items != nil && ports.count > 0 {
			for _, port := range unsafe.Slice(ports.items, int(ports.count)) {
				publishedPorts = append(publishedPorts, PublishedPort{
					GuestPort: int(port.guest_port),
					HostIP:    cString(port.host_ip),
					HostPort:  int(port.host_port),
					Protocol:  portProtocolFromCValue(port.protocol),
				})
			}
		}
	}

	return &NetworkInfo{
		Mode:           networkModeFromCValue(network.mode),
		AllowNet:       allowNet,
		PublishedPorts: publishedPorts,
	}
}

// convertBoxInfoList materialises a CBoxInfoList* into Go BoxInfo slice.
// The caller is responsible for freeing the C list afterwards.
func convertBoxInfoList(list *C.CBoxInfoList) []BoxInfo {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	out := make([]BoxInfo, len(items))
	for i := range items {
		out[i] = cBoxInfoToGo(&items[i])
	}
	return out
}
