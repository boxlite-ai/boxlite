package dto

import (
	"errors"
	"math"
)

// MemoryMiB validates GiB before conversion to the SDK's signed C integer.
func MemoryMiB(gib float64) (int, error) {
	mib := gib * 1024
	if math.IsNaN(mib) || math.IsInf(mib, 0) || mib < 256 || mib > math.MaxInt32 || math.Trunc(mib) != mib {
		return 0, errors.New("memoryQuota must represent integer MiB between 256 and 2147483647")
	}
	return int(mib), nil
}
