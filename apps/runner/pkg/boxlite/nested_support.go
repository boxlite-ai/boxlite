package boxlite

import (
	"os"
	"runtime"
	"strings"
)

// Cloud Runners use Linux KVM. Match libkrun's host probe before requesting
// the feature; a missing or unreadable setting leaves the VM ordinary.
func nestedVirtualizationAvailable() bool {
	return runtime.GOOS == "linux" && runtime.GOARCH == "amd64" && nestedVirtualizationEnabled(os.ReadFile)
}

func nestedVirtualizationEnabled(readFile func(string) ([]byte, error)) bool {
	for _, path := range []string{
		"/sys/module/kvm_intel/parameters/nested",
		"/sys/module/kvm_amd/parameters/nested",
	} {
		contents, err := readFile(path)
		if err == nil {
			value := strings.TrimSpace(string(contents))
			if value == "1" || strings.EqualFold(value, "Y") {
				return true
			}
		}
	}
	return false
}
