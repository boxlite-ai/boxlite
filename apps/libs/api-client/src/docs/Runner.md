# Runner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | The ID of the runner | [default to undefined]
**domain** | **string** | The domain of the runner | [optional] [default to undefined]
**apiUrl** | **string** | The API URL of the runner | [optional] [default to undefined]
**proxyUrl** | **string** | The proxy URL of the runner | [optional] [default to undefined]
**cpu** | **number** | The CPU capacity of the runner | [default to undefined]
**memory** | **number** | The memory capacity of the runner in GiB | [default to undefined]
**disk** | **number** | The disk capacity of the runner in GiB | [default to undefined]
**gpu** | **number** | The GPU capacity of the runner | [optional] [default to undefined]
**gpuType** | **string** | The type of GPU | [optional] [default to undefined]
**_class** | [**BoxClass**](BoxClass.md) | The class of the runner | [default to undefined]
**currentCpuUsagePercentage** | **number** | Current CPU usage percentage | [optional] [default to undefined]
**currentMemoryUsagePercentage** | **number** | Current RAM usage percentage | [optional] [default to undefined]
**currentDiskUsagePercentage** | **number** | Current disk usage percentage | [optional] [default to undefined]
**currentAllocatedCpu** | **number** | Current allocated CPU | [optional] [default to undefined]
**currentAllocatedMemoryGiB** | **number** | Current allocated memory in GiB | [optional] [default to undefined]
**currentAllocatedDiskGiB** | **number** | Current allocated disk in GiB | [optional] [default to undefined]
**currentSnapshotCount** | **number** | Current snapshot count | [optional] [default to undefined]
**currentStartedBoxes** | **number** | Current number of started boxes | [optional] [default to undefined]
**availabilityScore** | **number** | Runner availability score | [optional] [default to undefined]
**region** | **string** | The region of the runner | [default to undefined]
**name** | **string** | The name of the runner | [default to undefined]
**state** | [**RunnerState**](RunnerState.md) | The state of the runner | [default to undefined]
**lastChecked** | **string** | The last time the runner was checked | [optional] [default to undefined]
**unschedulable** | **boolean** | Whether the runner is unschedulable | [default to undefined]
**createdAt** | **string** | The creation timestamp of the runner | [default to undefined]
**updatedAt** | **string** | The last update timestamp of the runner | [default to undefined]
**version** | **string** | The version of the runner (deprecated in favor of apiVersion) | [default to undefined]
**apiVersion** | **string** | The api version of the runner | [default to undefined]
**appVersion** | **string** | The app version of the runner | [optional] [default to undefined]

## Example

```typescript
import { Runner } from './api';

const instance: Runner = {
    id,
    domain,
    apiUrl,
    proxyUrl,
    cpu,
    memory,
    disk,
    gpu,
    gpuType,
    _class,
    currentCpuUsagePercentage,
    currentMemoryUsagePercentage,
    currentDiskUsagePercentage,
    currentAllocatedCpu,
    currentAllocatedMemoryGiB,
    currentAllocatedDiskGiB,
    currentSnapshotCount,
    currentStartedBoxes,
    availabilityScore,
    region,
    name,
    state,
    lastChecked,
    unschedulable,
    createdAt,
    updatedAt,
    version,
    apiVersion,
    appVersion,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
