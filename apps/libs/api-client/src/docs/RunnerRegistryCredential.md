# RunnerRegistryCredential


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**kind** | [**RegistryCredentialKind**](RegistryCredentialKind.md) |  | [default to undefined]
**username** | **string** | Username the registry expects | [default to undefined]
**secretVersion** | **string** | Secret Manager version holding the password | [default to undefined]

## Example

```typescript
import { RunnerRegistryCredential } from './api';

const instance: RunnerRegistryCredential = {
    kind,
    username,
    secretVersion,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
