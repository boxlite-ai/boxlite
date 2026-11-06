package memorymonitor

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

func TestMemoryIncidentProcessIdentityMatchesBoxStart(t *testing.T) {
	ctx := context.Background()
	p, err := process.NewProcessWithContext(ctx, int32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	created, err := p.CreateTimeWithContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, started := range []time.Time{{}, time.UnixMilli(created - 1)} {
		if value, err := readProcessMemory(ctx, os.Getpid(), started); err == nil {
			t.Errorf("attributed %d RSS bytes to a missing or older Box start %s", value, started)
		}
	}
	if value, err := readProcessMemory(ctx, os.Getpid(), time.UnixMilli(created)); err != nil || value == 0 {
		t.Fatalf("matching process identity rejected: bytes=%d error=%v", value, err)
	}
}
