package boxlite

import (
	"io/fs"
	"testing"
)

func TestNestedVirtualizationHostCapability(t *testing.T) {
	for _, test := range []struct {
		name, intel, amd string
		want             bool
	}{
		{"disabled", "N", "0", false},
		{"intel", "Y\n", "0", true},
		{"amd", "0", "1\n", true},
		{"unknown", "true", "2", false},
		{"missing", "", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			read := func(path string) ([]byte, error) {
				switch path {
				case "/sys/module/kvm_intel/parameters/nested":
					if test.intel != "" {
						return []byte(test.intel), nil
					}
				case "/sys/module/kvm_amd/parameters/nested":
					if test.amd != "" {
						return []byte(test.amd), nil
					}
				default:
					t.Fatalf("unexpected host probe path %q", path)
				}
				return nil, fs.ErrPermission
			}
			if got := nestedVirtualizationEnabled(read); got != test.want {
				t.Fatalf("host capability=%v, want %v", got, test.want)
			}
		})
	}
}
