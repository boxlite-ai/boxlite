//go:build !boxlite_dev

package boxlite

// Prebuilt CGO directives — links against libboxlite.a downloaded by:
//   go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup

/*
#cgo CFLAGS: -I${SRCDIR}

#cgo darwin LDFLAGS: ${SRCDIR}/libboxlite.a
#cgo darwin LDFLAGS: -framework CoreFoundation -framework Security -framework IOKit
#cgo darwin LDFLAGS: -framework Hypervisor -framework vmnet -lresolv

#cgo linux LDFLAGS: ${SRCDIR}/libboxlite.a
#cgo linux LDFLAGS: -lresolv -lpthread -ldl -lrt -lm
*/
import "C"
