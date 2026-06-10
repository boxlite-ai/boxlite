# SnapshotDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** |  | [default to undefined]
**organizationId** | **string** |  | [optional] [default to undefined]
**general** | **boolean** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**imageName** | **string** |  | [optional] [default to undefined]
**state** | [**SnapshotState**](SnapshotState.md) |  | [default to undefined]
**size** | **number** |  | [default to undefined]
**entrypoint** | **Array&lt;string&gt;** |  | [default to undefined]
**cpu** | **number** |  | [default to undefined]
**gpu** | **number** |  | [default to undefined]
**mem** | **number** |  | [default to undefined]
**disk** | **number** |  | [default to undefined]
**errorReason** | **string** |  | [default to undefined]
**createdAt** | **Date** |  | [default to undefined]
**updatedAt** | **Date** |  | [default to undefined]
**lastUsedAt** | **Date** |  | [default to undefined]
**buildInfo** | [**BuildInfo**](BuildInfo.md) | Build information for the snapshot | [optional] [default to undefined]
**regionIds** | **Array&lt;string&gt;** | IDs of regions where the snapshot is available | [optional] [default to undefined]
**initialRunnerId** | **string** | The initial runner ID of the snapshot | [optional] [default to undefined]
**ref** | **string** | The snapshot reference | [optional] [default to undefined]

## Example

```typescript
import { SnapshotDto } from './api';

const instance: SnapshotDto = {
    id,
    organizationId,
    general,
    name,
    imageName,
    state,
    size,
    entrypoint,
    cpu,
    gpu,
    mem,
    disk,
    errorReason,
    createdAt,
    updatedAt,
    lastUsedAt,
    buildInfo,
    regionIds,
    initialRunnerId,
    ref,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
