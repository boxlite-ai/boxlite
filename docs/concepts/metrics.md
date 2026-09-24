# Metrics

BoxLite provides comprehensive metrics at runtime and per-Box levels.

## Architecture

```text
┌─────────────────────────────────────────┐
│            RuntimeMetrics               │
│  ┌─────────────────────────────────┐   │
│  │  AtomicU64 counters (lock-free) │   │
│  │  - boxes_created                │   │
│  │  - boxes_destroyed              │   │
│  │  - total_exec_calls             │   │
│  │  - total_bytes_transferred      │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│            BoxMetrics (per-Box)         │
│  - cpu_time_ms                          │
│  - memory_usage_bytes                   │
│  - exec_count                           │
│  - network_bytes_sent                   │
│  - network_bytes_received               │
└─────────────────────────────────────────┘
```

## Design principles

- **Lock-free**: Uses `AtomicU64` for concurrent updates without synchronization
- **Low overhead**: Metrics collection doesn't impact Box performance
- **Hierarchical**: Runtime-wide aggregates + per-Box details
