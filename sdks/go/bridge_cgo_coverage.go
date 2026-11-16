//go:build boxlite_dev && boxlite_coverage

package boxlite

// The coverage collector supplies the instrumented library and its matching
// LLVM profile runtime through CGO_LDFLAGS instead of the fixed dev archive.

/*
#cgo CFLAGS: -I${SRCDIR}/../c/include
#cgo darwin LDFLAGS: -framework CoreFoundation -framework Security -framework IOKit
#cgo darwin LDFLAGS: -framework Hypervisor -framework vmnet -lresolv
#cgo linux LDFLAGS: -lresolv -lpthread -ldl -lrt -lm
*/
import "C"
