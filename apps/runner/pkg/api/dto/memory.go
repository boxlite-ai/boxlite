package dto

import (
	"errors"
	"math"
)

// MemoryMiB validates GiB bounds, then rounds up to whole MiB for execution.
func MemoryMiB(gib float64) (int, error) {
	mib := gib * 1024
	if math.IsNaN(mib) || math.IsInf(mib, 0) || mib < 256 || mib > math.MaxInt32 {
		return 0, errors.New("memoryQuota must be between 256 and 2147483647 MiB")
	}
	return int(math.Ceil(mib)), nil
}
