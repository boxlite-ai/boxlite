//go:build boxlite_dev

package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import "unsafe"

// Go does not support importing C from a _test.go file. Keep the native test
// fixtures development-only so prebuilt SDK consumers do not compile test
// support into their package.
func cNetworkInfoTraversalTestFixtures() [4]*NetworkInfo {
	allowHost := C.CString("api.example.com")
	defer C.free(unsafe.Pointer(allowHost))
	allowNet := []*C.char{allowHost}
	unresolved := C.CNetworkInfo{
		outbound: C.COutboundNetworkInfo{
			mode:            C.BoxliteNetworkModeEnabled,
			allow_net:       (**C.char)(unsafe.Pointer(&allowNet[0])),
			allow_net_count: 1,
		},
		inbound: C.CInboundNetworkInfo{
			mode: C.BoxliteNetworkModeDisabled,
		},
	}

	resolvedPorts := C.CPublishedPortList{}
	resolvedEmpty := C.CNetworkInfo{
		outbound: C.COutboundNetworkInfo{
			mode: C.BoxliteNetworkModeDisabled,
		},
		inbound: C.CInboundNetworkInfo{
			mode: C.BoxliteNetworkModeEnabled,
		},
		published_ports: &resolvedPorts,
	}

	tcpHost := C.CString("127.0.0.1")
	defer C.free(unsafe.Pointer(tcpHost))
	udpHost := C.CString("::1")
	defer C.free(unsafe.Pointer(udpHost))
	portItems := []C.CPublishedPort{
		{
			guest_port: 3000,
			host_ip:    tcpHost,
			host_port:  49152,
			protocol:   C.BoxlitePortProtocolTcp,
		},
		{
			guest_port: 53,
			host_ip:    udpHost,
			host_port:  5353,
			protocol:   C.BoxlitePortProtocolUdp,
		},
	}
	populatedPorts := C.CPublishedPortList{
		items: &portItems[0],
		count: C.int(len(portItems)),
	}
	populated := C.CNetworkInfo{
		outbound: C.COutboundNetworkInfo{
			mode:            C.BoxliteNetworkModeEnabled,
			allow_net:       (**C.char)(unsafe.Pointer(&allowNet[0])),
			allow_net_count: 1,
		},
		inbound: C.CInboundNetworkInfo{
			mode: C.BoxliteNetworkModeEnabled,
		},
		published_ports: &populatedPorts,
	}

	return [4]*NetworkInfo{
		cNetworkInfoToGo(nil),
		cNetworkInfoToGo(&unresolved),
		cNetworkInfoToGo(&resolvedEmpty),
		cNetworkInfoToGo(&populated),
	}
}

// cBoxInfoExitCodeTestFixtures runs the owned pointer the C struct carries
// back through the real decode. `0` and "not recorded" are the two the design
// turns on, and nothing above this layer can tell them apart if this hop ever
// derives presence from the value instead of the pointer.
func cBoxInfoExitCodeTestFixtures() [3]*int {
	id := C.CString("box-1")
	defer C.free(unsafe.Pointer(id))
	image := C.CString("alpine:latest")
	defer C.free(unsafe.Pointer(image))
	status := C.CString("stopped")
	defer C.free(unsafe.Pointer(status))

	withCode := func(code *C.int) *int {
		info := C.CBoxInfo{
			id:        id,
			image:     image,
			status:    status,
			exit_code: code,
		}
		boxInfo := cBoxInfoToGo(&info)
		return boxInfo.ExitCode
	}

	// Allocated the way the real struct's owner does, so the decode sees a
	// genuine pointer rather than the address of a Go local.
	cleanExit := (*C.int)(C.malloc(C.sizeof_int))
	defer C.free(unsafe.Pointer(cleanExit))
	*cleanExit = 0

	failedExit := (*C.int)(C.malloc(C.sizeof_int))
	defer C.free(unsafe.Pointer(failedExit))
	*failedExit = 42

	return [3]*int{
		withCode(nil),
		withCode(cleanExit),
		withCode(failedExit),
	}
}
