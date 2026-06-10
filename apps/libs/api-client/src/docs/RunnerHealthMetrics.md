# RunnerHealthMetrics


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**currentCpuLoadAverage** | **number** | Current CPU load average | [default to undefined]
**currentCpuUsagePercentage** | **number** | Current CPU usage percentage | [default to undefined]
**currentMemoryUsagePercentage** | **number** | Current memory usage percentage | [default to undefined]
**currentDiskUsagePercentage** | **number** | Current disk usage percentage | [default to undefined]
**currentAllocatedCpu** | **number** | Currently allocated CPU cores | [default to undefined]
**currentAllocatedMemoryGiB** | **number** | Currently allocated memory in GiB | [default to undefined]
**currentAllocatedDiskGiB** | **number** | Currently allocated disk in GiB | [default to undefined]
**currentSnapshotCount** | **number** | Number of snapshots currently stored | [default to undefined]
**currentStartedBoxes** | **number** | Number of started boxes | [default to undefined]
**cpu** | **number** | Total CPU cores on the runner | [default to undefined]
**memoryGiB** | **number** | Total RAM in GiB on the runner | [default to undefined]
**diskGiB** | **number** | Total disk space in GiB on the runner | [default to undefined]

## Example

```typescript
import { RunnerHealthMetrics } from './api';

const instance: RunnerHealthMetrics = {
    currentCpuLoadAverage,
    currentCpuUsagePercentage,
    currentMemoryUsagePercentage,
    currentDiskUsagePercentage,
    currentAllocatedCpu,
    currentAllocatedMemoryGiB,
    currentAllocatedDiskGiB,
    currentSnapshotCount,
    currentStartedBoxes,
    cpu,
    memoryGiB,
    diskGiB,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
