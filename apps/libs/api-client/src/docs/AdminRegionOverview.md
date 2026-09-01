# AdminRegionOverview


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**type** | **string** |  | [default to undefined]
**state** | **string** |  | [default to undefined]
**runnerCount** | **number** |  | [default to undefined]
**boxCount** | **number** |  | [default to undefined]
**queueDepth** | **number** |  | [default to undefined]
**cpuCapacityMillis** | **number** |  | [optional] [default to undefined]
**memoryCapacityBytes** | **string** | Integer encoded as a decimal string | [optional] [default to undefined]
**observedAt** | **Date** |  | [optional] [default to undefined]

## Example

```typescript
import { AdminRegionOverview } from './api';

const instance: AdminRegionOverview = {
    id,
    name,
    type,
    state,
    runnerCount,
    boxCount,
    queueDepth,
    cpuCapacityMillis,
    memoryCapacityBytes,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
