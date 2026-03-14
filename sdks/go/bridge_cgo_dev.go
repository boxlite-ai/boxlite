//go:build boxlite_dev

package boxlite

// Development CGO directives — links against target/debug/libboxlite.a.
// Build the library first: make dev:go

/*
#cgo CFLAGS: -I${SRCDIR}/../c/include

#cgo darwin LDFLAGS: ${SRCDIR}/../../target/debug/libboxlite.a
#cgo darwin LDFLAGS: -framework CoreFoundation -framework Security -framework IOKit
#cgo darwin LDFLAGS: -framework Hypervisor -framework vmnet -lresolv

#cgo linux LDFLAGS: ${SRCDIR}/../../target/debug/libboxlite.a
#cgo linux LDFLAGS: -lresolv -lpthread -ldl -lrt -lm
*/
import "C"
