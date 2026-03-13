//go:build !boxlite_dev

package boxlite

// Default CGO directives — links against prebuilt libboxlite.a in lib/.
// Install the library first:
//
//	go generate github.com/boxlite-ai/boxlite/sdks/go/pkg/boxlite

/*
#cgo CFLAGS: -I${SRCDIR}/lib/include

#cgo darwin,arm64 LDFLAGS: ${SRCDIR}/lib/darwin-arm64/libboxlite.a
#cgo darwin,arm64 LDFLAGS: -framework CoreFoundation -framework Security -framework IOKit
#cgo darwin,arm64 LDFLAGS: -framework Hypervisor -framework vmnet -lresolv

#cgo linux,amd64 LDFLAGS: ${SRCDIR}/lib/linux-x64-gnu/libboxlite.a
#cgo linux,amd64 LDFLAGS: -lresolv -lpthread -ldl -lm
*/
import "C"
