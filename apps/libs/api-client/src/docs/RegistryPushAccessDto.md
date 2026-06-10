# RegistryPushAccessDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**username** | **string** | Temporary username for registry authentication | [default to undefined]
**secret** | **string** | Temporary secret for registry authentication | [default to undefined]
**registryUrl** | **string** | Registry URL | [default to undefined]
**registryId** | **string** | Registry ID | [default to undefined]
**project** | **string** | Registry project ID | [default to undefined]
**expiresAt** | **string** | Token expiration time in ISO format | [default to undefined]

## Example

```typescript
import { RegistryPushAccessDto } from './api';

const instance: RegistryPushAccessDto = {
    username,
    secret,
    registryUrl,
    registryId,
    project,
    expiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
