//go:build boxlite_dev && (boxlite_coverage || boxlite_external_archive)

package boxlite

// External builds supply the archive through CGO_LDFLAGS. Coverage builds
// also supply the matching LLVM profile runtime.

/*
#cgo CFLAGS: -I${SRCDIR}/../c/include
#cgo darwin LDFLAGS: -framework CoreFoundation -framework Security -framework IOKit
#cgo darwin LDFLAGS: -framework Hypervisor -framework vmnet -lresolv
#cgo linux LDFLAGS: -lresolv -lpthread -ldl -lrt -lm
*/
import "C"
