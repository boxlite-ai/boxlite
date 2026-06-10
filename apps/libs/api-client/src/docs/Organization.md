# Organization


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Organization ID | [default to undefined]
**name** | **string** | Organization name | [default to undefined]
**createdBy** | **string** | User ID of the organization creator | [default to undefined]
**personal** | **boolean** | Personal organization flag | [default to undefined]
**createdAt** | **Date** | Creation timestamp | [default to undefined]
**updatedAt** | **Date** | Last update timestamp | [default to undefined]
**suspended** | **boolean** | Suspended flag | [default to undefined]
**suspendedAt** | **Date** | Suspended at | [default to undefined]
**suspensionReason** | **string** | Suspended reason | [default to undefined]
**suspendedUntil** | **Date** | Suspended until | [default to undefined]
**suspensionCleanupGracePeriodHours** | **number** | Suspension cleanup grace period hours | [default to undefined]
**maxCpuPerBox** | **number** | Max CPU per box | [default to undefined]
**maxMemoryPerBox** | **number** | Max memory per box | [default to undefined]
**maxDiskPerBox** | **number** | Max disk per box | [default to undefined]
**snapshotDeactivationTimeoutMinutes** | **number** | Time in minutes before an unused snapshot is deactivated | [default to 20160]
**boxLimitedNetworkEgress** | **boolean** | Box default network block all | [default to undefined]
**defaultRegionId** | **string** | Default region ID | [optional] [default to undefined]
**authenticatedRateLimit** | **number** | Authenticated rate limit per minute | [default to undefined]
**boxCreateRateLimit** | **number** | Box create rate limit per minute | [default to undefined]
**boxLifecycleRateLimit** | **number** | Box lifecycle rate limit per minute | [default to undefined]
**experimentalConfig** | **object** | Experimental configuration | [default to undefined]
**authenticatedRateLimitTtlSeconds** | **number** | Authenticated rate limit TTL in seconds | [default to undefined]
**boxCreateRateLimitTtlSeconds** | **number** | Box create rate limit TTL in seconds | [default to undefined]
**boxLifecycleRateLimitTtlSeconds** | **number** | Box lifecycle rate limit TTL in seconds | [default to undefined]

## Example

```typescript
import { Organization } from './api';

const instance: Organization = {
    id,
    name,
    createdBy,
    personal,
    createdAt,
    updatedAt,
    suspended,
    suspendedAt,
    suspensionReason,
    suspendedUntil,
    suspensionCleanupGracePeriodHours,
    maxCpuPerBox,
    maxMemoryPerBox,
    maxDiskPerBox,
    snapshotDeactivationTimeoutMinutes,
    boxLimitedNetworkEgress,
    defaultRegionId,
    authenticatedRateLimit,
    boxCreateRateLimit,
    boxLifecycleRateLimit,
    experimentalConfig,
    authenticatedRateLimitTtlSeconds,
    boxCreateRateLimitTtlSeconds,
    boxLifecycleRateLimitTtlSeconds,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
