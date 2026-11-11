package dto

import (
	"encoding/json"
	"math"
	"testing"
)

func cpuQuota(cores float64) *float64 { return &cores }

func TestFractionalCPURequest(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want float64
	}{
		{`{}`, 1},
		{`{"cpuQuota":0.126}`, 0.126},
		{`{"cpuQuota":0.125}`, 0.125},
		{`{"cpuQuota":0.5}`, 0.5},
		{`{"cpuQuota":1.001}`, 1.001},
		{`{"cpuQuota":1.5}`, 1.5},
		{`{"cpuQuota":2}`, 2},
		{`{"cpuQuota":16}`, 16},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			var create CreateBoxDTO
			var recover RecoverBoxDTO
			if err := json.Unmarshal([]byte(tc.raw), &create); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(tc.raw), &recover); err != nil {
				t.Fatal(err)
			}
			got, err := CPUAllocation(create.CpuQuota)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := CPUAllocation(recover.CpuQuota)
			if err != nil || got != tc.want || restored != tc.want {
				t.Fatalf("create=%v recover=%v want=%v err=%v", got, restored, tc.want, err)
			}
		})
	}
	for _, n := range []float64{0, -1, 0.124, 0.1251, 16.001, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := CPUAllocation(&n); err == nil {
			t.Errorf("accepted %v", n)
		}
	}
}
