package binding

/*
#include <stdlib.h>
#include <stdbool.h>

// Declare C functions exported by Rust
int boxlite_go_ping();
void boxlite_go_free_string(char* s);

// Box CRUD
char* boxlite_go_create_box(const char* opts_json, const char* name, char** out_err);
void* boxlite_go_get_box(const char* id_or_name, char** out_err);
int boxlite_go_list_boxes(char** out_json, char** out_err);
int boxlite_go_remove_box(const char* id_or_name, bool force, char** out_err);

// Box operations
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

// Ping verifies the Go-Rust bridge is working correctly.
// Returns true if the bridge is operational.
func Ping() bool {
	return int(C.boxlite_go_ping()) == 42
}

// BoxOptions mirrors client.BoxOptions for JSON serialization.
type BoxOptions struct {
	Image      string            `json:"image"`
	CPUs       int               `json:"cpus,omitempty"`
	MemoryMB   int               `json:"memory_mb,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	WorkingDir string            `json:"working_dir,omitempty"`
}

// BoxInfo mirrors client.BoxInfo for JSON deserialization.
type BoxInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name,omitempty"`
	Image     string    `json:"image"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"created_at"`
}

// freeString frees a C string allocated by Rust.
func freeString(s *C.char) {
	C.boxlite_go_free_string(s)
}

// getError extracts error from C string and frees it.
func getError(errPtr *C.char) error {
	if errPtr == nil {
		return errors.New("unknown error")
	}
	msg := C.GoString(errPtr)
	freeString(errPtr)
	return errors.New(msg)
}

// CreateBox creates a new box with the given options.
// Returns the box ID on success.
func CreateBox(opts BoxOptions, name string) (string, error) {
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
	result := C.boxlite_go_create_box(cOptsJSON, cName, &outErr)

	if result == nil {
		return "", getError(outErr)
	}

	id := C.GoString(result)
	freeString(result)
	return id, nil
}

// GetBox retrieves a box handle by ID or name.
// Returns nil if the box is not found (not an error).
func GetBox(idOrName string) (unsafe.Pointer, string, error) {
	cIDOrName := C.CString(idOrName)
	defer C.free(unsafe.Pointer(cIDOrName))

	var outErr *C.char
	handle := C.boxlite_go_get_box(cIDOrName, &outErr)

	if handle == nil {
		if outErr != nil {
			return nil, "", getError(outErr)
		}
		return nil, "", nil // Not found
	}

	// Get the box ID
	cID := C.boxlite_go_box_id(handle)
	id := ""
	if cID != nil {
		id = C.GoString(cID)
		freeString(cID)
	}

	return handle, id, nil
}

// ListBoxes returns information about all boxes.
func ListBoxes() ([]BoxInfo, error) {
	var outJSON *C.char
	var outErr *C.char

	res := C.boxlite_go_list_boxes(&outJSON, &outErr)
	if res < 0 {
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

// RemoveBox removes a box by ID or name.
func RemoveBox(idOrName string, force bool) error {
	cIDOrName := C.CString(idOrName)
	defer C.free(unsafe.Pointer(cIDOrName))

	var outErr *C.char
	res := C.boxlite_go_remove_box(cIDOrName, C.bool(force), &outErr)

	if res < 0 {
		return getError(outErr)
	}
	return nil
}

// BoxStart starts a box.
func BoxStart(handle unsafe.Pointer) error {
	var outErr *C.char
	res := C.boxlite_go_box_start(handle, &outErr)
	if res < 0 {
		return getError(outErr)
	}
	return nil
}

// BoxStop stops a box.
func BoxStop(handle unsafe.Pointer) error {
	var outErr *C.char
	res := C.boxlite_go_box_stop(handle, &outErr)
	if res < 0 {
		return getError(outErr)
	}
	return nil
}

// GetBoxInfo gets box info as struct.
func GetBoxInfo(handle unsafe.Pointer) (*BoxInfo, error) {
	var outJSON *C.char
	var outErr *C.char

	res := C.boxlite_go_box_info(handle, &outJSON, &outErr)
	if res < 0 {
		return nil, getError(outErr)
	}

	jsonStr := C.GoString(outJSON)
	freeString(outJSON)

	var info BoxInfo
	if err := json.Unmarshal([]byte(jsonStr), &info); err != nil {
		return nil, err
	}

	return &info, nil
}

// BoxFree frees a box handle.
func BoxFree(handle unsafe.Pointer) {
	C.boxlite_go_box_free(handle)
}
