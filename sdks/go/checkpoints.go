package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"runtime/cgo"
	"sync"
	"unsafe"
)

// CheckpointInfo describes a memory checkpoint. CreatedAt is Unix seconds.
type CheckpointInfo struct {
	Id                 string
	BoxId              string
	Name               string
	Status             string
	Error              string
	CreatedAt          int64
	CPUs               uint16
	MemoryBytes        uint64
	ContainerDiskBytes uint64
	SizeBytes          uint64
}

// Checkpoints manages one source box or the runtime catalog. Close releases the handle.
type Checkpoints struct {
	mu      sync.RWMutex
	runtime *Runtime
	handle  *C.CBoxliteCheckpointHandle
}

func closedCheckpointsError() error {
	return &Error{Code: ErrInvalidState, Message: "checkpoint handle is closed"}
}

// Checkpoints returns the runtime catalog, including checkpoints of deleted source boxes.
//
// The C-side checkpoint handle is created synchronously; async operations
// (Create, List, Get, Remove) post events into the parent runtime's event
// queue and are dispatched by the runtime drain goroutine.
func (r *Runtime) Checkpoints() (*Checkpoints, error) {
	if err := checkpointRuntimeReady(r); err != nil {
		return nil, err
	}
	var handle *C.CBoxliteCheckpointHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_checkpoints(r.handle, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Checkpoints{runtime: r, handle: handle}, nil
}

// Create captures this handle's box and waits for a ready checkpoint.
// Pass "" for a generated name. Runtime-scoped handles reject capture.
func (v *Checkpoints) Create(ctx context.Context, name string) (*CheckpointInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(name, "checkpoint", true); err != nil {
		return nil, err
	}
	if v == nil {
		return nil, closedCheckpointsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedCheckpointsError()
	}
	v.runtime.ensureDrainRunning()

	ch := make(chan checkpointResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cName *C.char
	if name != "" {
		cName = toCString(name)
		defer C.free(unsafe.Pointer(cName))
	}

	var cerr C.CBoxliteError
	code := C.boxlite_checkpoint_create(v.handle, cName, C.cbCheckpointInfo(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ctx.Err()
	case <-v.runtime.closing:
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// List lists checkpoints in this handle's box or runtime scope.
func (v *Checkpoints) List(ctx context.Context) ([]CheckpointInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if v == nil {
		return nil, closedCheckpointsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedCheckpointsError()
	}
	v.runtime.ensureDrainRunning()

	ch := make(chan checkpointListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_checkpoint_list(v.handle, C.cbCheckpointList(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ctx.Err()
	case <-v.runtime.closing:
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// Get accepts a checkpoint ID or name within this handle's scope.
// Missing box-scoped checkpoints return nil; organization lookups return ErrNotFound.
func (v *Checkpoints) Get(ctx context.Context, id string) (*CheckpointInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(id, "checkpoint", false); err != nil {
		return nil, err
	}
	if v == nil {
		return nil, closedCheckpointsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedCheckpointsError()
	}
	v.runtime.ensureDrainRunning()

	cID := toCString(id)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan checkpointResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_checkpoint_get(v.handle, cID, C.cbCheckpointInfo(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ctx.Err()
	case <-v.runtime.closing:
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// Remove removes a checkpoint by id. With force, a missing checkpoint is a no-op.
func (v *Checkpoints) Remove(ctx context.Context, id string, force bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateArchiveArgument(id, "checkpoint", false); err != nil {
		return err
	}
	if v == nil {
		return closedCheckpointsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return closedCheckpointsError()
	}
	v.runtime.ensureDrainRunning()

	cID := toCString(id)
	defer C.free(unsafe.Pointer(cID))

	forceFlag := C.int(0)
	if force {
		forceFlag = 1
	}

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_checkpoint_remove(v.handle, cID, forceFlag, C.cbCheckpointOp(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, v.runtime.closing)
		return ctx.Err()
	case <-v.runtime.closing:
		abandonAsyncErr(ch, h, v.runtime.closing)
		return ErrRuntimeClosed
	}
}

// Close releases the checkpoint handle.
func (v *Checkpoints) Close() error {
	if v != nil {
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.handle != nil {
			C.boxlite_checkpoint_free(v.handle)
			v.handle = nil
		}
	}
	return nil
}

// cCheckpointInfoToGo materialises a single CCheckpointInfo into a Go CheckpointInfo. It
// does not free the C struct; the caller owns that.
func cCheckpointInfoToGo(info *C.CCheckpointInfo) CheckpointInfo {
	return CheckpointInfo{
		Id: cString(info.id), BoxId: cString(info.box_id), Name: cString(info.name),
		Status: cString(info.status), Error: cString(info.error),
		CreatedAt: int64(info.created_at), CPUs: uint16(info.cpus), MemoryBytes: uint64(info.memory_bytes), ContainerDiskBytes: uint64(info.container_disk_bytes),
		SizeBytes: uint64(info.size_bytes),
	}
}

// convertCheckpointInfoList materialises a CCheckpointInfoList* into a Go CheckpointInfo
// slice. The caller is responsible for freeing the C list afterwards.
func convertCheckpointInfoList(list *C.CCheckpointInfoList) []CheckpointInfo {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	checkpoints := make([]CheckpointInfo, len(items))
	for idx := range items {
		checkpoints[idx] = cCheckpointInfoToGo(&items[idx])
	}
	return checkpoints
}

// Checkpoints returns checkpoints captured from this box. Restore always creates a new box.
// The handle retains the native box until Close is called.
func (b *Box) Checkpoints() (*Checkpoints, error) {
	if b == nil || b.handle == nil {
		return nil, &Error{Code: ErrInvalidState, Message: "box handle is closed"}
	}
	var handle *C.CBoxliteCheckpointHandle
	var cerr C.CBoxliteError
	if code := C.boxlite_box_checkpoints(b.handle, &handle, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}
	return &Checkpoints{runtime: b.runtime, handle: handle}, nil
}

// PauseOptions declares whether writers outside the VM have been stopped.
type PauseOptions struct{ HostWritersStopped bool }

// CheckpointImportOptions names the newly imported Paused box. Empty means unnamed.
type CheckpointImportOptions struct{ Name string }

// CheckpointDependencies preserves all dependencies of a caller-local public pair.
type CheckpointDependencies struct {
	Version            uint32                      `json:"version"`
	CPUs               uint16                      `json:"cpus"`
	MemoryBytes        uint64                      `json:"memory_bytes"`
	BootMemoryMiB      uint32                      `json:"boot_memory_mib"`
	MaxMemoryMiB       uint32                      `json:"max_memory_mib"`
	ContainerDiskBytes uint64                      `json:"container_disk_bytes"`
	BootDiskBytes      uint64                      `json:"boot_disk_bytes"`
	BootDiskSHA256     string                      `json:"boot_disk_sha256"`
	QCOW2Bytes         uint64                      `json:"qcow2_bytes"`
	QCOW2SHA256        string                      `json:"qcow2_sha256"`
	Shares             []CheckpointShareDependency `json:"shares"`
	LocalRoots         map[string]string           `json:"local_roots"`
	BootDiskPath       *string                     `json:"boot_disk_path"`
	DiskDependencies   json.RawMessage             `json:"disk_dependencies"`
}

type CheckpointShareDependency struct {
	Tag      string                       `json:"tag"`
	VMOwned  bool                         `json:"vm_owned"`
	ReadOnly bool                         `json:"read_only"`
	Objects  []CheckpointObjectDependency `json:"objects"`
	State    json.RawMessage              `json:"state"`
}

type CheckpointObjectDependency struct {
	Alias     uint64                     `json:"alias"`
	GuestIno  uint64                     `json:"guest_ino"`
	Ctime     [2]int64                   `json:"ctime"`
	Kind      uint32                     `json:"kind"`
	Unlinked  bool                       `json:"unlinked"`
	Reference *CheckpointObjectReference `json:"reference"`
	Recipe    *string                    `json:"recipe"`
}

type CheckpointObjectReference struct {
	ResourceID    string `json:"resource_id"`
	RecoveryPoint string `json:"recovery_point"`
	ObjectKey     string `json:"object_key"`
}

// CloudCheckpointInspection is the runner-only native upload admission summary.
// It contains no saved host paths or security configuration.
type CloudCheckpointInspection struct {
	Version            uint32                       `json:"version"`
	PairSHA256         string                       `json:"pair_sha256"`
	MemoryFileBytes    uint64                       `json:"memory_file_bytes"`
	QCOW2Bytes         uint64                       `json:"qcow2_bytes"`
	ContainerDiskBytes uint64                       `json:"container_disk_bytes"`
	BootDiskBytes      uint64                       `json:"boot_disk_bytes"`
	BootDiskSHA256     string                       `json:"boot_disk_sha256"`
	Resources          CloudCheckpointResources     `json:"resources"`
	Configuration      CloudCheckpointConfiguration `json:"configuration"`
}

type CloudCheckpointResources struct {
	CPUs         uint8  `json:"cpus"`
	MemoryMiB    uint32 `json:"memory_mib"`
	MaxCPUs      uint8  `json:"max_cpus"`
	MaxMemoryMiB uint32 `json:"max_memory_mib"`
}

type CheckpointNetworkPolicy struct {
	Mode     NetworkMode `json:"mode"`
	AllowNet []string    `json:"allow_net"`
}

type CloudCheckpointConfiguration struct {
	Image      string                  `json:"image"`
	Env        [][2]string             `json:"env"`
	WorkingDir *string                 `json:"working_dir"`
	User       *string                 `json:"user"`
	Entrypoint *[]string               `json:"entrypoint"`
	Cmd        *[]string               `json:"cmd"`
	TTY        bool                    `json:"tty"`
	Privileged bool                    `json:"privileged"`
	Outbound   CheckpointNetworkPolicy `json:"outbound"`
	Inbound    CheckpointNetworkPolicy `json:"inbound"`
}

// CloudCheckpointImportOptions are runner-only registration inputs. TrustedBoot
// must come from the runtime cache or an organization-authorized boot download;
// never pass a saved metadata path or a public client's host pathname.
type CloudCheckpointImportOptions struct {
	OperationID        string `json:"operation_id"`
	ExpectedPairSHA256 string `json:"expected_pair_sha256"`
	TrustedBoot        string `json:"trusted_boot,omitempty"`
}

func checkpointRuntimeReady(r *Runtime) error {
	if r == nil || r.handle == nil {
		return ErrRuntimeClosed
	}
	select {
	case <-r.closing:
		return ErrRuntimeClosed
	default:
		return nil
	}
}

type checkpointSubmit func(unsafe.Pointer, *C.CBoxliteError) C.enum_BoxliteErrorCode

func (r *Runtime) checkpointUnit(ctx context.Context, submit checkpointSubmit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := checkpointRuntimeReady(r); err != nil {
		return err
	}
	r.ensureDrainRunning()
	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	if code := submit(handleToPtr(h), &cerr); code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, r.closing)
		return ctx.Err()
	case <-r.closing:
		abandonAsyncErr(ch, h, r.closing)
		return ErrRuntimeClosed
	}
}

func (r *Runtime) checkpointInfo(ctx context.Context, submit checkpointSubmit) (*CheckpointInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := checkpointRuntimeReady(r); err != nil {
		return nil, err
	}
	r.ensureDrainRunning()
	ch := make(chan checkpointResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	if code := submit(handleToPtr(h), &cerr); code != C.Ok {
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

func (r *Runtime) checkpointBox(ctx context.Context, submit checkpointSubmit) (*Box, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := checkpointRuntimeReady(r); err != nil {
		return nil, err
	}
	r.ensureDrainRunning()
	ch := make(chan handleResult[*C.CBoxHandle], 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	if code := submit(handleToPtr(h), &cerr); code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}
	dispose := func(b *C.CBoxHandle) {
		if b != nil {
			C.boxlite_box_free(b)
		}
	}
	select {
	case res := <-ch:
		if res.err != nil {
			dispose(res.value)
			return nil, res.err
		}
		name := C.boxlite_box_name(res.value)
		defer freeBoxliteString(name)
		return newBoxFromHandle(r, res.value, cString(name)), nil
	case <-ctx.Done():
		abandonOwnedResult(ch, h, dispose)
		return nil, ctx.Err()
	case <-r.closing:
		abandonOwnedResult(ch, h, dispose)
		return nil, ErrRuntimeClosed
	}
}

// Pause freezes guest execution. A cancelled wait does not undo a submitted pause.
func (b *Box) Pause(ctx context.Context, options PauseOptions) error {
	if b == nil || b.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "box handle is closed"}
	}
	flag := C.int(0)
	if options.HostWritersStopped {
		flag = 1
	}
	return b.runtime.checkpointUnit(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_pause(b.handle, flag, C.cbCheckpointOp(), ud, e)
	})
}

// Resume explicitly continues a Paused box; it never substitutes a cold start.
func (b *Box) Resume(ctx context.Context) error {
	if b == nil || b.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "box handle is closed"}
	}
	return b.runtime.checkpointUnit(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_resume(b.handle, C.cbCheckpointOp(), ud, e)
	})
}

// ExportCheckpoint writes a public two-file checkpoint to a caller-local directory.
// Keep that directory available until native completion. Cancellation only stops waiting.
func (b *Box) ExportCheckpoint(ctx context.Context, path string) error {
	if err := validateArchiveArgument(path, "checkpoint path", false); err != nil {
		return err
	}
	if b == nil || b.handle == nil {
		return &Error{Code: ErrInvalidState, Message: "box handle is closed"}
	}
	p := toCString(path)
	defer C.free(unsafe.Pointer(p))
	return b.runtime.checkpointUnit(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_export_checkpoint(b.handle, p, C.cbCheckpointOp(), ud, e)
	})
}

// ImportCheckpoint uploads/imports a caller-local public pair into a new Paused box.
// Source files must outlive native completion, even after ctx cancellation.
func (r *Runtime) ImportCheckpoint(ctx context.Context, path string, options CheckpointImportOptions) (*Box, error) {
	if err := validateArchiveArgument(path, "checkpoint path", false); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(options.Name, "checkpoint name", true); err != nil {
		return nil, err
	}
	p := toCString(path)
	defer C.free(unsafe.Pointer(p))
	name, freeName := archiveNameCString(options.Name)
	defer freeName()
	return r.checkpointBox(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_import_checkpoint(r.handle, p, name, C.cbCreateBox(), ud, e)
	})
}

// CreateFromCheckpoint creates a new Paused box preserving captured resources.
// Pass an empty name for an unnamed box. Call Resume explicitly to continue it.
func (r *Runtime) CreateFromCheckpoint(ctx context.Context, id, name string) (*Box, error) {
	return r.createFromCheckpoint(ctx, id, name, "")
}

// CreateFromCheckpointWithOperation is runner-only cloud restore with a durable
// operation identity; its native configuration is validated and rebuilt for cloud use.
func (r *Runtime) CreateFromCheckpointWithOperation(ctx context.Context, id, name, operationID string) (*Box, error) {
	if err := validateArchiveArgument(operationID, "operation ID", false); err != nil {
		return nil, err
	}
	return r.createFromCheckpoint(ctx, id, name, operationID)
}

func (r *Runtime) createFromCheckpoint(ctx context.Context, id, name, operationID string) (*Box, error) {
	for _, arg := range []struct {
		v, label string
		empty    bool
	}{{id, "checkpoint", false}, {name, "box name", true}, {operationID, "operation ID", true}} {
		if err := validateArchiveArgument(arg.v, arg.label, arg.empty); err != nil {
			return nil, err
		}
	}
	ci := toCString(id)
	defer C.free(unsafe.Pointer(ci))
	cn, freeName := archiveNameCString(name)
	defer freeName()
	op := toCString(operationID)
	defer C.free(unsafe.Pointer(op))
	return r.checkpointBox(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		if operationID != "" {
			return C.boxlite_create_box_from_checkpoint_with_operation(r.handle, ci, cn, op, C.cbCreateBox(), ud, e)
		}
		return C.boxlite_create_box_from_checkpoint(r.handle, ci, cn, C.cbCreateBox(), ud, e)
	})
}

// InspectCheckpoint reads caller-local dependencies without creating a runtime or VM.
func InspectCheckpoint(path string) (*CheckpointDependencies, error) {
	var value CheckpointDependencies
	if err := inspectCheckpointJSON(path, false, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

// InspectCloudUpload performs native runner-only upload validation and returns an allowlist.
func InspectCloudUpload(path string) (*CloudCheckpointInspection, error) {
	var value CloudCheckpointInspection
	if err := inspectCheckpointJSON(path, true, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func inspectCheckpointJSON(path string, cloud bool, value any) error {
	if err := validateArchiveArgument(path, "checkpoint path", false); err != nil {
		return err
	}
	p := toCString(path)
	defer C.free(unsafe.Pointer(p))
	var out *C.char
	var cerr C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	if cloud {
		code = C.boxlite_inspect_cloud_upload(p, &out, &cerr)
	} else {
		code = C.boxlite_inspect_checkpoint(p, &out, &cerr)
	}
	if code != C.Ok {
		return freeError(&cerr)
	}
	defer freeBoxliteString(out)
	return json.Unmarshal([]byte(cString(out)), value)
}

// ImportCheckpointPair registers a validated public pair; it creates no box or VM.
// Retain path and TrustedBoot until native completion. Runner cleanup should wait
// for this call using a non-cancelled completion context before removing staging.
func (r *Runtime) ImportCheckpointPair(ctx context.Context, path string, options CloudCheckpointImportOptions) (*CheckpointInfo, error) {
	if err := validateArchiveArgument(path, "checkpoint path", false); err != nil {
		return nil, err
	}
	data, err := json.Marshal(options)
	if err != nil {
		return nil, err
	}
	p := toCString(path)
	defer C.free(unsafe.Pointer(p))
	opts := toCString(string(data))
	defer C.free(unsafe.Pointer(opts))
	return r.checkpointInfo(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_import_checkpoint_pair(r.handle, p, opts, C.cbCheckpointInfo(), ud, e)
	})
}

// ExportCheckpointArchive is runner-only managed transport, including owned boot.
func (r *Runtime) ExportCheckpointArchive(ctx context.Context, id, path string) error {
	if err := validateArchiveArgument(id, "checkpoint", false); err != nil {
		return err
	}
	if err := validateArchiveArgument(path, "archive path", false); err != nil {
		return err
	}
	ci := toCString(id)
	defer C.free(unsafe.Pointer(ci))
	p := toCString(path)
	defer C.free(unsafe.Pointer(p))
	return r.checkpointUnit(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_export_checkpoint_archive(r.handle, ci, p, C.cbCheckpointOp(), ud, e)
	})
}

// ImportCheckpointArchive registers runner-only managed transport with durable identity.
// Keep the archive until native completion; context cancellation only stops waiting.
func (r *Runtime) ImportCheckpointArchive(ctx context.Context, path, operationID string) (*CheckpointInfo, error) {
	if err := validateArchiveArgument(path, "archive path", false); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(operationID, "operation ID", false); err != nil {
		return nil, err
	}
	p := toCString(path)
	defer C.free(unsafe.Pointer(p))
	op := toCString(operationID)
	defer C.free(unsafe.Pointer(op))
	return r.checkpointInfo(ctx, func(ud unsafe.Pointer, e *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_import_checkpoint_archive(r.handle, p, op, C.cbCheckpointInfo(), ud, e)
	})
}
