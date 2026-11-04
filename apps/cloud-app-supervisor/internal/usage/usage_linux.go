//go:build linux

package usage

import (
	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"os"
	"path/filepath"
	"syscall"
)

// GroupMemory is the resident memory of every process in the group pgid (a
// service runs in its own group, with its children), or nil if unreadable.
func GroupMemory(pgid int) *int64 {
	paths, err := filepath.Glob("/proc/[0-9]*/stat")
	if err != nil {
		return nil
	}
	var pages int64
	found := false
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			continue // the process exited meanwhile
		}
		if g, rss, ok := statGroupRSS(string(b)); ok && g == pgid {
			pages += rss
			found = true
		}
	}
	if !found {
		return nil
	}
	bytes := pages * int64(os.Getpagesize())
	return &bytes
}

// ReadBox reads the Box's memory and the disk holding dir, or nil if either is unreadable.
func ReadBox(dir string) *api.Box {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return nil
	}
	defer f.Close()
	total, available, ok := meminfo(f)
	var fs syscall.Statfs_t
	if !ok || syscall.Statfs(dir, &fs) != nil {
		return nil
	}
	return &api.Box{
		MemoryTotalBytes:     total,
		MemoryAvailableBytes: available,
		DiskTotalBytes:       int64(fs.Blocks) * int64(fs.Bsize),
		DiskFreeBytes:        int64(fs.Bavail) * int64(fs.Bsize),
	}
}
