package memorymonitor

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestMemoryIncidentReadsWholeBoxCgroup(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("uses Linux cgroup dispatch")
	}
	root := t.TempDir()
	proc, groups := filepath.Join(root, "proc"), filepath.Join(root, "groups")
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(proc, "123/cgroup"), "0::/boxlite/runtime-a\n")
	write(filepath.Join(groups, "boxlite/runtime-a/memory.current"), "4294967296\n")
	// A launcher-only value must not replace the cgroup including VM children.
	write(filepath.Join(proc, "123/status"), "VmRSS:\t1 kB\n")
	m := testMonitor([]Box{{ID: "business-a", RuntimeID: "runtime-a", PID: 123, Image: "image:a"}})
	m.read = newMemoryReader(proc, groups)
	m.Observe(context.Background(), time.Now(), 90)
	event := <-m.reports
	if !event.SamplingComplete || len(event.Boxes) != 1 || event.Boxes[0].MemoryBytes != 4294967296 || event.Boxes[0].BoxID != "business-a" {
		t.Fatalf("wrong attribution: %+v", event)
	}
	for _, membership := range []string{"0::/", "0::/boxlite/other", "0::/boxlite/../runtime-a", "0::boxlite/runtime-a", "1:memory:/boxlite/runtime-a"} {
		write(filepath.Join(proc, "123/cgroup"), membership)
		if _, err := readCgroupMemory(proc, groups, Box{RuntimeID: "runtime-a", PID: 123}); err == nil {
			t.Fatalf("accepted membership %q", membership)
		}
	}
	write(filepath.Join(proc, "123/cgroup"), "0::/boxlite/runtime-a\n")
	for _, body := range []string{"", "-1", "1.2", "9223372036854775808", "10 extra"} {
		write(filepath.Join(groups, "boxlite/runtime-a/memory.current"), body)
		if _, err := readCgroupMemory(proc, groups, Box{RuntimeID: "runtime-a", PID: 123}); err == nil {
			t.Fatalf("accepted counter %q", body)
		}
	}
	if err := os.Remove(filepath.Join(groups, "boxlite/runtime-a/memory.current")); err != nil {
		t.Fatal(err)
	}
	m.Observe(context.Background(), time.Now(), 90)
	event = <-m.reports
	if event.SamplingComplete || len(event.Boxes) != 0 {
		t.Fatalf("missing cgroup was attributed: %+v", event)
	}
	if _, err := readMemory(context.Background(), Box{PID: 0}); err == nil {
		t.Fatal("accepted missing PID")
	}
}
