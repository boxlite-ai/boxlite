# RegistryCredential


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** |  | [default to undefined]
**kind** | [**RegistryCredentialKind**](RegistryCredentialKind.md) |  | [default to undefined]
**registryHost** | **string** |  | [default to undefined]
**repositoryPrefix** | **string** | Empty for the whole registry | [default to undefined]
**username** | **string** |  | [default to undefined]
**createdBy** | **string** | The user who added it | [default to undefined]
**createdAt** | **string** |  | [default to undefined]

## Example

```typescript
import { RegistryCredential } from './api';

const instance: RegistryCredential = {
    id,
    kind,
    registryHost,
    repositoryPrefix,
    username,
    createdBy,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
