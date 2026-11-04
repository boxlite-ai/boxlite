// Package usage reads how much memory a service and the Box use and how full
// the Box's disk is, for /.boxlite/sv/health. Linux only; elsewhere every
// reading is absent (nil), never zero.
package usage

import (
	"bufio"
	"io"
	"strconv"
	"strings"
)

// meminfo reads MemTotal and MemAvailable (kB) from /proc/meminfo.
func meminfo(r io.Reader) (total, available int64, ok bool) {
	sc := bufio.NewScanner(r)
	seen := 0
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		kb, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil {
			continue
		}
		switch f[0] {
		case "MemTotal:":
			total, seen = kb*1024, seen+1
		case "MemAvailable:":
			available, seen = kb*1024, seen+1
		}
	}
	return total, available, seen == 2
}

// statGroupRSS returns the process group and resident pages of one
// /proc/<pid>/stat line. The command name may hold spaces and parentheses,
// so fields are counted from the last ')'.
func statGroupRSS(line string) (pgrp int, rssPages int64, ok bool) {
	i := strings.LastIndexByte(line, ')')
	if i < 0 {
		return 0, 0, false
	}
	f := strings.Fields(line[i+1:])
	// After the name: state(0) ppid(1) pgrp(2) … rss is field 24 of the line, 21 here.
	if len(f) < 22 {
		return 0, 0, false
	}
	g, err1 := strconv.Atoi(f[2])
	rss, err2 := strconv.ParseInt(f[21], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return g, rss, true
}
