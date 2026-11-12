package dto

import (
	"errors"
	"math"
)

// MemoryMiB converts exact GiB quotas without rounding the requested allocation.
func MemoryMiB(quota float64) (int, error) {
	// Internal callers historically omit memory and receive the 128 MiB floor.
	// HTTP validation still rejects an explicit zero quota.
	if quota == 0 {
		return 128, nil
	}
	mib := quota * 1024
	if math.IsNaN(mib) || math.IsInf(mib, 0) || mib < 128 || mib > 4294967295 || math.Trunc(mib) != mib {
		return 0, errors.New("memoryQuota must represent whole MiB between 128 and 4294967295")
	}
	return int(mib), nil
}
