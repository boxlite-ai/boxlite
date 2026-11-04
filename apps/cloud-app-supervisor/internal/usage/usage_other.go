//go:build !linux

package usage

import "github.com/boxlite-ai/microcloud/supervisor/internal/api"

// GroupMemory has no /proc to read outside Linux.
func GroupMemory(pgid int) *int64 { return nil }

// ReadBox has no /proc/meminfo to read outside Linux.
func ReadBox(dir string) *api.Box { return nil }
