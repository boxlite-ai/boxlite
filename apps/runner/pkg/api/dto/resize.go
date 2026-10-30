package dto

type BoxResources struct {
	CPUs         uint8  `json:"cpus"`
	MemoryMiB    uint32 `json:"memory_mib"`
	MaxCPUs      uint8  `json:"max_cpus"`
	MaxMemoryMiB uint32 `json:"max_memory_mib"`
}

type ResizeBoxPayload struct {
	Version   int    `json:"version"`
	CPUs      uint8  `json:"cpus"`
	MemoryMiB uint32 `json:"memory_mib"`
}
