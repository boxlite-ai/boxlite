package dto

type BoxResources struct {
	CPUs         float64 `json:"cpus"`
	MemoryMiB    uint32  `json:"memory_mib"`
	MaxCPUs      uint8   `json:"max_cpus"`
	MaxMemoryMiB uint32  `json:"max_memory_mib"`
}

type ResizeBoxPayload struct {
	Version   int     `json:"version"`
	CPUs      float64 `json:"cpus"`
	MemoryMiB uint32  `json:"memory_mib"`
}
