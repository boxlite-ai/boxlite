# OrganizationUsageOverview


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**currentCpuUsage** | **number** | vCPU currently consumed by running boxes | [default to undefined]
**totalCpuQuota** | **number** | Total vCPU the organization may consume | [default to undefined]
**currentMemoryUsage** | **number** | Memory in GB currently consumed by running boxes | [default to undefined]
**totalMemoryQuota** | **number** | Total memory in GB the organization may consume | [default to undefined]
**currentDiskUsage** | **number** | Disk in GB currently occupied by boxes | [default to undefined]
**totalDiskQuota** | **number** | Total disk in GB the organization may occupy | [default to undefined]
**currentGpuUsage** | **number** | GPUs currently consumed by running boxes | [default to undefined]
**totalGpuQuota** | **number** | Total GPUs the organization may consume; 0 denies GPU boxes | [default to undefined]
**currentBoxUsage** | **number** | Boxes currently running | [default to undefined]
**maxConcurrentBoxes** | **number** | Maximum number of concurrently running boxes | [default to undefined]

## Example

```typescript
import { OrganizationUsageOverview } from './api';

const instance: OrganizationUsageOverview = {
    currentCpuUsage,
    totalCpuQuota,
    currentMemoryUsage,
    totalMemoryQuota,
    currentDiskUsage,
    totalDiskQuota,
    currentGpuUsage,
    totalGpuQuota,
    currentBoxUsage,
    maxConcurrentBoxes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
