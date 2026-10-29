package cpumonitor

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCPUIncidentCgroupCounter(t *testing.T) {
	root := t.TempDir()
	procRoot, cgroupRoot := filepath.Join(root, "proc"), filepath.Join(root, "cgroup")
	box := Box{ID: "business-box", RuntimeID: "local-id", PID: 123, StartedAt: time.Unix(1700000000, 0)}
	membership := filepath.Join(procRoot, "123", "cgroup")
	statPath := filepath.Join(cgroupRoot, "user.slice", "boxlite", box.RuntimeID, "cpu.stat")
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(membership, "0::/user.slice/boxlite/local-id\n")
	write(statPath, "usage_usec 1000000\nuser_usec 700000\nsystem_usec 300000\n")
	first, err := readCgroupCounter(procRoot, cgroupRoot, box)
	if err != nil || first.seconds != 1 {
		t.Fatalf("counter: %+v %v", first, err)
	}
	w := window{complete: true}
	w.add(map[string]counter{box.ID: first}, true)
	write(statPath, "usage_usec 121000000\n")
	last, err := readCgroupCounter(procRoot, cgroupRoot, box)
	if err != nil {
		t.Fatal(err)
	}
	w.add(map[string]counter{box.ID: last}, true)
	event := w.finish(Incident{})
	if event.BoxID == nil || *event.BoxID != box.ID || event.CPUSeconds != 120 || !event.SamplingComplete {
		t.Fatalf("cgroup attribution: %+v", event)
	}
	if err := os.Rename(statPath, statPath+".old"); err != nil {
		t.Fatal(err)
	}
	write(statPath, "usage_usec 999000000\n")
	replaced, err := readCgroupCounter(procRoot, cgroupRoot, box)
	if err != nil || replaced.identity == last.identity {
		t.Fatalf("missed replacement: %+v %v", replaced, err)
	}
	for _, body := range []string{"user_usec 20\n", "usage_usec -1\n", "usage_usec bad\n"} {
		write(statPath, body)
		if _, err := readCgroupCounter(procRoot, cgroupRoot, box); err == nil {
			t.Fatalf("accepted invalid stat %q", body)
		}
	}
	for _, body := range []string{"0::/\n", "0::/boxlite/other\n", "0::/a/../boxlite/local-id\n", "0::relative/boxlite/local-id\n", "1:cpu:/boxlite/local-id\n"} {
		write(membership, body)
		if _, err := readCgroupCounter(procRoot, cgroupRoot, box); err == nil {
			t.Fatalf("accepted wrong membership %q", body)
		}
	}
}
