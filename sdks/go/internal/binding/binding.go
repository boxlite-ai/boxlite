// Package binding provides the CGo bridge between the Go SDK client and the Rust BoxLite runtime.
// It defines the Runtime and Box interfaces that abstract the underlying FFI implementation.
package binding

/*
#cgo LDFLAGS: -L${SRCDIR}/../../../../target/debug -lboxlite_go_bridge -Wl,-rpath,${SRCDIR}/../../../../target/debug
#cgo darwin LDFLAGS: -framework CoreFoundation -framework IOKit -framework DiskArbitration

#include <stdlib.h>
#include <stdbool.h>

void boxlite_go_free_string(char* s);
void* boxlite_go_runtime_new(const char* config_json, char** out_err);
void boxlite_go_runtime_free(void* runtime);
char* boxlite_go_create_box(void* runtime, const char* opts_json, const char* name, char** out_err);
void* boxlite_go_get_box(void* runtime, const char* id_or_name, char** out_err);
int boxlite_go_list_boxes(void* runtime, char** out_json, char** out_err);
int boxlite_go_remove_box(void* runtime, const char* id_or_name, bool force, char** out_err);
int boxlite_go_box_start(void* handle, char** out_err);
int boxlite_go_box_stop(void* handle, char** out_err);
int boxlite_go_box_info(void* handle, char** out_json, char** out_err);
char* boxlite_go_box_id(void* handle);
void boxlite_go_box_free(void* handle);
*/
import "C"
import (
	"encoding/json"
	"errors"
	"time"
	"unsafe"
)

// BoxOptions holds the configuration for creating a new box.
type BoxOptions struct {
	Image      string            `json:"image"`
	CPUs       int               `json:"cpus,omitempty"`
	MemoryMB   int               `json:"memory_mb,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	WorkingDir string            `json:"working_dir,omitempty"`
}

// BoxInfo contains runtime information about a box.
type BoxInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name,omitempty"`
	Image     string    `json:"image"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"created_at"`
}

// RuntimeOptions holds the configuration for creating a Runtime.
type RuntimeOptions struct {
	HomeDir         string   `json:"home_dir,omitempty"`
	ImageRegistries []string `json:"image_registries,omitempty"`
}

// ============================================================================
// CGo implementation
// ============================================================================

func freeString(s *C.char) {
	C.boxlite_go_free_string(s)
}

func getError(errPtr *C.char) error {
	if errPtr == nil {
		return errors.New("unknown error")
	}
	msg := C.GoString(errPtr)
	freeString(errPtr)
	return errors.New(msg)
}

// Box is the CGo-backed implementation of the Box handle.
type Box struct{ handle unsafe.Pointer }

func (b *Box) Start() error {
	var outErr *C.char
	if res := C.boxlite_go_box_start(b.handle, &outErr); res < 0 {
		return getError(outErr)
	}
	return nil
}

func (b *Box) Stop() error {
	var outErr *C.char
	if res := C.boxlite_go_box_stop(b.handle, &outErr); res < 0 {
		return getError(outErr)
	}
	return nil
}

func (b *Box) Info() (BoxInfo, error) {
	var outJSON, outErr *C.char
	if res := C.boxlite_go_box_info(b.handle, &outJSON, &outErr); res < 0 {
		return BoxInfo{}, getError(outErr)
	}
	jsonStr := C.GoString(outJSON)
	freeString(outJSON)
	var info BoxInfo
	if err := json.Unmarshal([]byte(jsonStr), &info); err != nil {
		return BoxInfo{}, err
	}
	return info, nil
}

func (b *Box) Free() {
	if b.handle != nil {
		C.boxlite_go_box_free(b.handle)
		b.handle = nil
	}
}

// Runtime is the CGo-backed BoxLite runtime implementation.
type Runtime struct{ handle unsafe.Pointer }

// NewRuntime creates a new BoxLite runtime instance.
func NewRuntime(opts *RuntimeOptions) (*Runtime, error) {
	var configJSON *C.char
	if opts != nil {
		data, err := json.Marshal(opts)
		if err != nil {
			return nil, err
		}
		configJSON = C.CString(string(data))
		defer C.free(unsafe.Pointer(configJSON))
	}
	var outErr *C.char
	handle := C.boxlite_go_runtime_new(configJSON, &outErr)
	if handle == nil {
		return nil, getError(outErr)
	}
	return &Runtime{handle: handle}, nil
}

func (r *Runtime) CreateBox(name string, opts BoxOptions) (string, error) {
	optsJSON, err := json.Marshal(opts)
	if err != nil {
		return "", err
	}
	cOptsJSON := C.CString(string(optsJSON))
	defer C.free(unsafe.Pointer(cOptsJSON))

	var cName *C.char
	if name != "" {
		cName = C.CString(name)
		defer C.free(unsafe.Pointer(cName))
	}
	var outErr *C.char
	result := C.boxlite_go_create_box(r.handle, cOptsJSON, cName, &outErr)
	if result == nil {
		return "", getError(outErr)
	}
	id := C.GoString(result)
	freeString(result)
	return id, nil
}

func (r *Runtime) GetBox(idOrName string) (*Box, string, error) {
	cIDOrName := C.CString(idOrName)
	defer C.free(unsafe.Pointer(cIDOrName))
	var outErr *C.char
	handle := C.boxlite_go_get_box(r.handle, cIDOrName, &outErr)
	if handle == nil {
		if outErr != nil {
			return nil, "", getError(outErr)
		}
		return nil, "", nil
	}
	cID := C.boxlite_go_box_id(handle)
	id := ""
	if cID != nil {
		id = C.GoString(cID)
		freeString(cID)
	}
	return &Box{handle: handle}, id, nil
}

func (r *Runtime) ListBoxes() ([]BoxInfo, error) {
	var outJSON, outErr *C.char
	if res := C.boxlite_go_list_boxes(r.handle, &outJSON, &outErr); res < 0 {
		return nil, getError(outErr)
	}
	jsonStr := C.GoString(outJSON)
	freeString(outJSON)
	var infos []BoxInfo
	if err := json.Unmarshal([]byte(jsonStr), &infos); err != nil {
		return nil, err
	}
	return infos, nil
}

func (r *Runtime) RemoveBox(idOrName string, force bool) error {
	cIDOrName := C.CString(idOrName)
	defer C.free(unsafe.Pointer(cIDOrName))
	var outErr *C.char
	if res := C.boxlite_go_remove_box(r.handle, cIDOrName, C.bool(force), &outErr); res < 0 {
		return getError(outErr)
	}
	return nil
}

func (r *Runtime) Free() {
	if r.handle != nil {
		C.boxlite_go_runtime_free(r.handle)
		r.handle = nil
	}
}
