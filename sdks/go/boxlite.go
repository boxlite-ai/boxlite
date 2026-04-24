// Package boxlite provides an idiomatic Go SDK for the BoxLite runtime.
//
// BoxLite is an embeddable virtual machine runtime for secure, isolated code
// execution. Think "SQLite for sandboxing".
//
// # Quick Start
//
//	rt, err := boxlite.NewRuntime()
//	if err != nil { log.Fatal(err) }
//	defer rt.Close()
//
//	box, err := rt.Create(ctx, "alpine:latest", boxlite.WithName("my-box"))
//	if err != nil { log.Fatal(err) }
//	defer box.Close()
//
//	result, err := box.Exec(ctx, "echo", "hello")
//	fmt.Println(result.Stdout) // "hello\n"
package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"encoding/json"
	"time"
	"unsafe"
)

// Version returns the BoxLite library version string.
func Version() string {
	return C.GoString(C.boxlite_version())
}

// Runtime manages BoxLite boxes. Create one with NewRuntime.
type Runtime struct {
	handle *C.CBoxliteRuntime
}

// NewRuntime creates a new BoxLite runtime.
func NewRuntime(opts ...RuntimeOption) (*Runtime, error) {
	cfg := &runtimeConfig{}
	for _, o := range opts {
		o(cfg)
	}

	var homeDir *C.char
	if cfg.homeDir != "" {
		homeDir = toCString(cfg.homeDir)
		defer C.free(unsafe.Pointer(homeDir))
	}

	var registriesJSON *C.char
	if len(cfg.registries) > 0 {
		data, err := json.Marshal(cfg.registries)
		if err != nil {
			return nil, err
		}
		registriesJSON = toCString(string(data))
		defer C.free(unsafe.Pointer(registriesJSON))
	}

	var insecureJSON *C.char
	if len(cfg.insecureRegistries) > 0 {
		data, err := json.Marshal(cfg.insecureRegistries)
		if err != nil {
			return nil, err
		}
		insecureJSON = toCString(string(data))
		defer C.free(unsafe.Pointer(insecureJSON))
	}

	var handle *C.CBoxliteRuntime
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_new(homeDir, registriesJSON, insecureJSON, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Runtime{handle: handle}, nil
}

// Close releases the runtime.
func (r *Runtime) Close() error {
	if r.handle != nil {
		C.boxlite_runtime_free(r.handle)
		r.handle = nil
	}
	return nil
}

// Shutdown gracefully stops all boxes in this runtime.
func (r *Runtime) Shutdown(_ context.Context, timeout time.Duration) error {
	secs := int(timeout.Seconds())
	if secs <= 0 {
		secs = 0
	}
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_shutdown(r.handle, C.int(secs), &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Create creates and returns a new box.
func (r *Runtime) Create(_ context.Context, image string, opts ...BoxOption) (*Box, error) {
	cfg := &boxConfig{}
	for _, o := range opts {
		o(cfg)
	}

	cImage := toCString(image)
	defer C.free(unsafe.Pointer(cImage))

	var cOpts *C.CBoxliteOptions
	var cerr C.CBoxliteError
	code := C.boxlite_options_new(cImage, &cOpts, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	if cfg.name != "" {
		cName := toCString(cfg.name)
		C.boxlite_options_set_name(cOpts, cName)
		C.free(unsafe.Pointer(cName))
	}
	if cfg.cpus > 0 {
		C.boxlite_options_set_cpus(cOpts, C.int(cfg.cpus))
	}
	if cfg.memoryMiB > 0 {
		C.boxlite_options_set_memory(cOpts, C.int(cfg.memoryMiB))
	}
	if cfg.diskSizeGB > 0 {
		C.boxlite_options_set_disk(cOpts, C.int64_t(cfg.diskSizeGB))
	}
	if cfg.user != "" {
		cUser := toCString(cfg.user)
		C.boxlite_options_set_user(cOpts, cUser)
		C.free(unsafe.Pointer(cUser))
	}
	if cfg.workDir != "" {
		cDir := toCString(cfg.workDir)
		C.boxlite_options_set_workdir(cOpts, cDir)
		C.free(unsafe.Pointer(cDir))
	}
	for _, e := range cfg.env {
		cKey := toCString(e[0])
		cVal := toCString(e[1])
		C.boxlite_options_add_env(cOpts, cKey, cVal)
		C.free(unsafe.Pointer(cKey))
		C.free(unsafe.Pointer(cVal))
	}
	for _, v := range cfg.volumes {
		cHost := toCString(v.hostPath)
		cGuest := toCString(v.guestPath)
		ro := C.int(0)
		if v.readOnly {
			ro = 1
		}
		C.boxlite_options_add_volume(cOpts, cHost, cGuest, ro)
		C.free(unsafe.Pointer(cHost))
		C.free(unsafe.Pointer(cGuest))
	}
	for _, p := range cfg.ports {
		hp := 0
		if p.hostPort != nil {
			hp = *p.hostPort
		}
		C.boxlite_options_add_port(cOpts, C.int(p.guestPort), C.int(hp))
	}
	if cfg.network != nil {
		if cfg.network.disabled {
			C.boxlite_options_set_network_disabled(cOpts)
		} else {
			C.boxlite_options_set_network_enabled(cOpts)
			for _, h := range cfg.network.allowNet {
				cHost := toCString(h)
				C.boxlite_options_add_network_allow(cOpts, cHost)
				C.free(unsafe.Pointer(cHost))
			}
		}
	}
	if cfg.autoRemove != nil {
		v := C.int(0)
		if *cfg.autoRemove {
			v = 1
		}
		C.boxlite_options_set_auto_remove(cOpts, v)
	}
	if cfg.detach != nil {
		v := C.int(0)
		if *cfg.detach {
			v = 1
		}
		C.boxlite_options_set_detach(cOpts, v)
	}
	if cfg.entrypoint != nil {
		cArgs, argc := toCStringArray(cfg.entrypoint)
		C.boxlite_options_set_entrypoint(cOpts, cArgs, C.int(argc))
		freeCStringArray(cArgs, argc)
	}
	if cfg.cmd != nil {
		cArgs, argc := toCStringArray(cfg.cmd)
		C.boxlite_options_set_cmd(cOpts, cArgs, C.int(argc))
		freeCStringArray(cArgs, argc)
	}

	var boxHandle *C.CBoxHandle
	code = C.boxlite_create_box(r.handle, cOpts, &boxHandle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	cID := C.boxlite_box_id(boxHandle)
	id := ""
	if cID != nil {
		id = C.GoString(cID)
		freeBoxliteString(cID)
	}

	return &Box{handle: boxHandle, id: id, name: cfg.name}, nil
}

// Get retrieves an existing box by ID or name.
func (r *Runtime) Get(_ context.Context, idOrName string) (*Box, error) {
	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	var boxHandle *C.CBoxHandle
	var cerr C.CBoxliteError
	code := C.boxlite_get(r.handle, cID, &boxHandle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	cBoxID := C.boxlite_box_id(boxHandle)
	id := ""
	if cBoxID != nil {
		id = C.GoString(cBoxID)
		freeBoxliteString(cBoxID)
	}

	return &Box{handle: boxHandle, id: id}, nil
}

// ListInfo lists all boxes using C structs (no JSON).
func (r *Runtime) ListInfo(_ context.Context) ([]BoxInfo, error) {
	var cList *C.CBoxInfoList
	var cerr C.CBoxliteError
	code := C.boxlite_list_info_struct(r.handle, &cList, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_box_info_list(cList)

	count := int(cList.count)
	items := unsafe.Slice(cList.items, count)
	result := make([]BoxInfo, count)
	for i := 0; i < count; i++ {
		result[i] = cBoxInfoToGo(&items[i])
	}
	return result, nil
}

// Remove removes a box by ID or name.
func (r *Runtime) Remove(_ context.Context, idOrName string) error {
	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	var cerr C.CBoxliteError
	code := C.boxlite_remove(r.handle, cID, 0, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// ForceRemove forcefully removes a box (stops it first if running).
func (r *Runtime) ForceRemove(_ context.Context, idOrName string) error {
	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	var cerr C.CBoxliteError
	code := C.boxlite_remove(r.handle, cID, 1, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// PullImage pulls an OCI image into the local cache.
func (r *Runtime) PullImage(_ context.Context, imageRef string) error {
	cRef := toCString(imageRef)
	defer C.free(unsafe.Pointer(cRef))

	var cerr C.CBoxliteError
	code := C.boxlite_image_pull(r.handle, cRef, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// ListImages lists all locally cached images using C structs (no JSON).
func (r *Runtime) ListImages(_ context.Context) ([]ImageInfo, error) {
	var cList *C.CImageInfoList
	var cerr C.CBoxliteError
	code := C.boxlite_image_list_struct(r.handle, &cList, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_image_info_list(cList)

	count := int(cList.count)
	items := unsafe.Slice(cList.items, count)
	result := make([]ImageInfo, count)
	for i := 0; i < count; i++ {
		item := &items[i]
		result[i] = ImageInfo{
			Reference:  C.GoString(item.reference),
			Repository: C.GoString(item.repository),
			Tag:        C.GoString(item.tag),
			ID:         C.GoString(item.id),
			CachedAt:   time.Unix(int64(item.cached_at), 0),
		}
		if item.has_size != 0 {
			size := uint64(item.size)
			result[i].Size = &size
		}
	}
	return result, nil
}

// Metrics returns aggregate runtime metrics using C struct (no JSON).
func (r *Runtime) Metrics(_ context.Context) (*RuntimeMetrics, error) {
	var cm C.CRuntimeMetrics
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_metrics_struct(r.handle, &cm, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &RuntimeMetrics{
		BoxesCreatedTotal:     int(cm.boxes_created_total),
		BoxesFailedTotal:      int(cm.boxes_failed_total),
		RunningBoxes:          int(cm.num_running_boxes),
		TotalCommandsExecuted: int(cm.total_commands_executed),
		TotalExecErrors:       int(cm.total_exec_errors),
	}, nil
}

// cBoxInfoToGo converts a C CBoxInfo to a Go BoxInfo.
func cBoxInfoToGo(c *C.CBoxInfo) BoxInfo {
	return BoxInfo{
		ID:        C.GoString(c.id),
		Name:      C.GoString(c.name),
		Image:     C.GoString(c.image),
		State:     State(C.GoString(c.status)),
		Running:   c.running != 0,
		PID:       int(c.pid),
		CPUs:      int(c.cpus),
		MemoryMiB: int(c.memory_mib),
		CreatedAt: time.Unix(int64(c.created_at), 0),
	}
}
