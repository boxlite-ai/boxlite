package dto

import (
	"fmt"
	"math"
)

// CPUAllocation preserves omission's historical default while rejecting an
// explicitly invalid value. Both HTTP requests and job payloads use this rule.
func CPUAllocation(quota *float64) (float64, error) {
	if quota == nil {
		return 1, nil
	}
	cores := *quota
	if math.IsNaN(cores) || math.IsInf(cores, 0) || cores < MinCPUs || cores > 16 || math.Round(cores*1000)/1000 != cores {
		return 0, fmt.Errorf("cpuQuota must be between %g and 16, in increments of 0.001 cores", MinCPUs)
	}
	return cores, nil
}
