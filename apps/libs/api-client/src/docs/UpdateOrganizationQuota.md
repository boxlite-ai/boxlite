# UpdateOrganizationQuota


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**maxCpuPerBox** | **number** |  | [default to undefined]
**maxMemoryPerBox** | **number** |  | [default to undefined]
**maxDiskPerBox** | **number** |  | [default to undefined]
**snapshotQuota** | **number** |  | [default to undefined]
**maxSnapshotSize** | **number** |  | [default to undefined]
**volumeQuota** | **number** |  | [default to undefined]
**authenticatedRateLimit** | **number** |  | [default to undefined]
**boxCreateRateLimit** | **number** |  | [default to undefined]
**boxLifecycleRateLimit** | **number** |  | [default to undefined]
**authenticatedRateLimitTtlSeconds** | **number** |  | [default to undefined]
**boxCreateRateLimitTtlSeconds** | **number** |  | [default to undefined]
**boxLifecycleRateLimitTtlSeconds** | **number** |  | [default to undefined]
**snapshotDeactivationTimeoutMinutes** | **number** | Time in minutes before an unused snapshot is deactivated | [default to undefined]

## Example

```typescript
import { UpdateOrganizationQuota } from './api';

const instance: UpdateOrganizationQuota = {
    maxCpuPerBox,
    maxMemoryPerBox,
    maxDiskPerBox,
    snapshotQuota,
    maxSnapshotSize,
    volumeQuota,
    authenticatedRateLimit,
    boxCreateRateLimit,
    boxLifecycleRateLimit,
    authenticatedRateLimitTtlSeconds,
    boxCreateRateLimitTtlSeconds,
    boxLifecycleRateLimitTtlSeconds,
    snapshotDeactivationTimeoutMinutes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
