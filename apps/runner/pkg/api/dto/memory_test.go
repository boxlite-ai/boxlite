package dto

import (
	"encoding/json"
	"math"
	"testing"
)

func TestMemoryMiBContract(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int
	}{
		{`{}`, 128}, {`{"memoryQuota":0.125}`, 128}, {`{"memoryQuota":0.29296875}`, 300},
		{`{"memoryQuota":0.5}`, 512}, {`{"memoryQuota":1}`, 1024}, {`{"memoryQuota":1.5}`, 1536},
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
			for _, quota := range []float64{create.MemoryQuota, recover.MemoryQuota} {
				got, err := MemoryMiB(quota)
				if err != nil || got != tc.want {
					t.Fatalf("got %v MiB, want %v: %v", got, tc.want, err)
				}
			}
		})
	}
	for _, quota := range []float64{-1, 0.124, 0.3, 4194304, math.NaN(), math.Inf(1)} {
		if _, err := MemoryMiB(quota); err == nil {
			t.Errorf("accepted invalid quota %v", quota)
		}
	}
}
