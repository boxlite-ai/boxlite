# BuildSnapshotRequestDTO


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**context** | **Array&lt;string&gt;** |  | [optional] [default to undefined]
**dockerfile** | **string** |  | [default to undefined]
**organizationId** | **string** |  | [default to undefined]
**pushToInternalRegistry** | **boolean** |  | [optional] [default to undefined]
**registry** | [**RegistryDTO**](RegistryDTO.md) |  | [optional] [default to undefined]
**snapshot** | **string** | Snapshot ID and tag or the build\&#39;s hash | [optional] [default to undefined]
**sourceRegistries** | [**Array&lt;RegistryDTO&gt;**](RegistryDTO.md) |  | [optional] [default to undefined]

## Example

```typescript
import { BuildSnapshotRequestDTO } from './api';

const instance: BuildSnapshotRequestDTO = {
    context,
    dockerfile,
    organizationId,
    pushToInternalRegistry,
    registry,
    snapshot,
    sourceRegistries,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
