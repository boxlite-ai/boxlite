package usage

import (
	"strings"
	"testing"
)

func TestMeminfo(t *testing.T) {
	total, available, ok := meminfo(strings.NewReader("MemTotal:        2048000 kB\nMemFree:          100 kB\nMemAvailable:    1024000 kB\n"))
	if !ok || total != 2048000*1024 || available != 1024000*1024 {
		t.Fatalf("got %d %d %v", total, available, ok)
	}
	if _, _, ok := meminfo(strings.NewReader("MemTotal: 1 kB\n")); ok {
		t.Fatal("a file without MemAvailable must not read as ok")
	}
}

func TestStatGroupRSS(t *testing.T) {
	// A command name with spaces and a ')' must not shift the fields.
	line := "4242 (node (worker) x) S 1 4240 4240 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 7 0 12345 987654321 3210 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0"
	g, rss, ok := statGroupRSS(line)
	if !ok || g != 4240 || rss != 3210 {
		t.Fatalf("got pgrp %d rss %d ok %v", g, rss, ok)
	}
	if _, _, ok := statGroupRSS("garbage"); ok {
		t.Fatal("garbage must not parse")
	}
}
