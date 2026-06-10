# PullSnapshotRequestDTO


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**destinationRef** | **string** |  | [optional] [default to undefined]
**destinationRegistry** | [**RegistryDTO**](RegistryDTO.md) |  | [optional] [default to undefined]
**newTag** | **string** |  | [optional] [default to undefined]
**registry** | [**RegistryDTO**](RegistryDTO.md) |  | [optional] [default to undefined]
**snapshot** | **string** |  | [default to undefined]

## Example

```typescript
import { PullSnapshotRequestDTO } from './api';

const instance: PullSnapshotRequestDTO = {
    destinationRef,
    destinationRegistry,
    newTag,
    registry,
    snapshot,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
