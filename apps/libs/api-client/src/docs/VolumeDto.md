# VolumeDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Volume ID | [default to undefined]
**name** | **string** | Volume name | [default to undefined]
**organizationId** | **string** | Organization ID | [default to undefined]
**state** | [**VolumeState**](VolumeState.md) | Volume state | [default to undefined]
**createdAt** | **string** | Creation timestamp | [default to undefined]
**updatedAt** | **string** | Last update timestamp | [default to undefined]
**lastUsedAt** | **string** | Last used timestamp | [optional] [default to undefined]
**errorReason** | **string** | The error reason of the volume | [default to undefined]

## Example

```typescript
import { VolumeDto } from './api';

const instance: VolumeDto = {
    id,
    name,
    organizationId,
    state,
    createdAt,
    updatedAt,
    lastUsedAt,
    errorReason,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
