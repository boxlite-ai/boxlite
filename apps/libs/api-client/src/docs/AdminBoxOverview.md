# AdminBoxOverview


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**organizationId** | **string** |  | [default to undefined]
**runnerId** | **string** |  | [optional] [default to undefined]
**regionId** | **string** |  | [default to undefined]
**desiredState** | **string** |  | [default to undefined]
**observedState** | **string** |  | [default to undefined]
**health** | **string** |  | [default to undefined]
**cpuMillis** | **number** |  | [optional] [default to undefined]
**memoryBytes** | **string** | Integer encoded as a decimal string | [optional] [default to undefined]
**storageBytes** | **string** | Integer encoded as a decimal string | [optional] [default to undefined]
**activeJobCount** | **number** |  | [default to undefined]
**observedAt** | **Date** |  | [optional] [default to undefined]

## Example

```typescript
import { AdminBoxOverview } from './api';

const instance: AdminBoxOverview = {
    id,
    name,
    organizationId,
    runnerId,
    regionId,
    desiredState,
    observedState,
    health,
    cpuMillis,
    memoryBytes,
    storageBytes,
    activeJobCount,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
