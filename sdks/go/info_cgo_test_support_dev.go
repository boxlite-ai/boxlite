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
	// The effective list deliberately differs from allow_net, so a converter
	// that read the wrong pointer would be caught rather than coincide.
	secretHost := C.CString("secret.example.com")
	defer C.free(unsafe.Pointer(secretHost))
	effectiveAllowNet := []*C.char{allowHost, secretHost}
	unresolved := C.CNetworkInfo{
		outbound: C.COutboundNetworkInfo{
			mode:                      C.BoxliteNetworkModeEnabled,
			allow_net:                 (**C.char)(unsafe.Pointer(&allowNet[0])),
			allow_net_count:           1,
			effective_allow_net:       (**C.char)(unsafe.Pointer(&effectiveAllowNet[0])),
			effective_allow_net_count: 2,
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
			mode:                      C.BoxliteNetworkModeEnabled,
			allow_net:                 (**C.char)(unsafe.Pointer(&allowNet[0])),
			allow_net_count:           1,
			effective_allow_net:       (**C.char)(unsafe.Pointer(&allowNet[0])),
			effective_allow_net_count: 1,
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
