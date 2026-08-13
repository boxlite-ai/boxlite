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
		mode:            C.BoxliteNetworkModeEnabled,
		allow_net:       (**C.char)(unsafe.Pointer(&allowNet[0])),
		allow_net_count: 1,
	}

	resolvedPorts := C.CPublishedPortList{}
	resolvedEmpty := C.CNetworkInfo{
		mode:            C.BoxliteNetworkModeDisabled,
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
		mode:            C.BoxliteNetworkModeEnabled,
		allow_net:       (**C.char)(unsafe.Pointer(&allowNet[0])),
		allow_net_count: 1,
		published_ports: &populatedPorts,
	}

	return [4]*NetworkInfo{
		cNetworkInfoToGo(nil),
		cNetworkInfoToGo(&unresolved),
		cNetworkInfoToGo(&resolvedEmpty),
		cNetworkInfoToGo(&populated),
	}
}

// A zero CBoxInfo traverses safely — cString and cNetworkInfoToGo both tolerate
// NULL — so these fixtures vary only the exit-code fields.
func cBoxInfoExitCodeTestFixtures() [3]*int {
	unrecorded := C.CBoxInfo{}
	exitedNonZero := C.CBoxInfo{exit_code: 3, has_exit_code: 1}
	exitedZero := C.CBoxInfo{has_exit_code: 1}

	return [3]*int{
		cBoxInfoToGo(&unrecorded).ExitCode,
		cBoxInfoToGo(&exitedNonZero).ExitCode,
		cBoxInfoToGo(&exitedZero).ExitCode,
	}
}
