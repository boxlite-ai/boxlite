package dto

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"

	apiClient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestMemoryMiB(t *testing.T) {
	for _, mib := range []int{256, 257, 512, 513, 768, 1536, 16777217, math.MaxInt32} {
		body := []byte(fmt.Sprintf(`{"memoryQuota":%.12f}`, float64(mib)/1024))
		var created CreateBoxDTO
		var recovered RecoverBoxDTO
		if err := json.Unmarshal(body, &created); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(body, &recovered); err != nil {
			t.Fatal(err)
		}
		for _, quota := range []float64{created.MemoryQuota, recovered.MemoryQuota} {
			got, err := MemoryMiB(quota)
			if err != nil || got != mib {
				t.Fatalf("%d MiB: got %d, %v", mib, got, err)
			}
		}
	}
	for _, gib := range []float64{0, -1, 255.0 / 1024, 256.5 / 1024, math.NaN(), math.Inf(1), float64(math.MaxInt32+1) / 1024} {
		if _, err := MemoryMiB(gib); err == nil {
			t.Fatalf("accepted %v GiB", gib)
		}
	}
}

func TestMemoryAPIModelPrecision(t *testing.T) {
	for _, mib := range []int{256, 513, 16777217, math.MaxInt32} {
		var box apiClient.Box
		body := []byte(fmt.Sprintf(`{"id":"memory","organizationId":"org","name":"memory","user":"root","env":{},"labels":{},"target":"test","cpu":1,"gpu":0,"disk":1,"memory":%.12f}`, float64(mib)/1024))
		if err := json.Unmarshal(body, &box); err != nil {
			t.Fatal(err)
		}
		if got := float64(box.GetMemory()) * 1024; got != float64(mib) {
			t.Fatalf("API model changed %d MiB to %v", mib, got)
		}
	}
}
