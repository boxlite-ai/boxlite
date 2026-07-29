# AdminOrganizationQuota


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**totalCpuQuota** | **number** | Total vCPU an organization may have running at once | [default to undefined]
**totalMemoryQuota** | **number** | Total memory in GB an organization may have running at once | [default to undefined]
**totalDiskQuota** | **number** | Total disk in GB an organization may occupy | [default to undefined]
**totalGpuQuota** | **number** | Total GPUs an organization may have running at once; 0 denies GPU boxes | [default to undefined]
**maxConcurrentBoxes** | **number** | Maximum number of concurrently running boxes | [default to undefined]
**maxVolumes** | **number** | Maximum number of volumes occupying storage | [default to undefined]
**customized** | **boolean** | False when the organization has no quota row and is running on the built-in defaults | [default to undefined]

## Example

```typescript
import { AdminOrganizationQuota } from './api';

const instance: AdminOrganizationQuota = {
    totalCpuQuota,
    totalMemoryQuota,
    totalDiskQuota,
    totalGpuQuota,
    maxConcurrentBoxes,
    maxVolumes,
    customized,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
