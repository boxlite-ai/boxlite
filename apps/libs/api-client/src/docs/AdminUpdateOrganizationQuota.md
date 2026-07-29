# AdminUpdateOrganizationQuota


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**totalCpuQuota** | **number** | Total vCPU an organization may have running at once | [optional] [default to undefined]
**totalMemoryQuota** | **number** | Total memory in GB an organization may have running at once | [optional] [default to undefined]
**totalDiskQuota** | **number** | Total disk in GB an organization may occupy | [optional] [default to undefined]
**totalGpuQuota** | **number** | Total GPUs an organization may have running at once | [optional] [default to undefined]
**maxConcurrentBoxes** | **number** | Maximum number of concurrently running boxes | [optional] [default to undefined]

## Example

```typescript
import { AdminUpdateOrganizationQuota } from './api';

const instance: AdminUpdateOrganizationQuota = {
    totalCpuQuota,
    totalMemoryQuota,
    totalDiskQuota,
    totalGpuQuota,
    maxConcurrentBoxes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
