package boxlite

/*
#include "bridge.h"
*/
import "C"

import "unsafe"

//export goBoxliteOnCheckpointInfo
func goBoxliteOnCheckpointInfo(info *C.CCheckpointInfo, nativeError *C.CBoxliteError, userData unsafe.Pointer) {
	dispose := func(value **C.CCheckpointInfo) {
		if value != nil {
			C.boxlite_free_checkpoint_info(*value)
		}
	}
	handle := ptrToHandle(userData)
	if handle == 0 {
		dispose(&info)
		return
	}
	if !claimOrFreePayload(handle, &info, dispose) {
		return
	}
	defer handle.Delete()
	result, ok := handle.Value().(chan handleResult[*C.CCheckpointInfo])
	if !ok {
		dispose(&info)
		return
	}
	result <- handleResult[*C.CCheckpointInfo]{value: info, err: errorFromCError(nativeError)}
}

//export goBoxliteOnCheckpointList
func goBoxliteOnCheckpointList(list *C.CCheckpointList, nativeError *C.CBoxliteError, userData unsafe.Pointer) {
	dispose := func(value **C.CCheckpointList) {
		if value != nil {
			C.boxlite_free_checkpoint_list(*value)
		}
	}
	handle := ptrToHandle(userData)
	if handle == 0 {
		dispose(&list)
		return
	}
	if !claimOrFreePayload(handle, &list, dispose) {
		return
	}
	defer handle.Delete()
	result, ok := handle.Value().(chan handleResult[*C.CCheckpointList])
	if !ok {
		dispose(&list)
		return
	}
	result <- handleResult[*C.CCheckpointList]{value: list, err: errorFromCError(nativeError)}
}
