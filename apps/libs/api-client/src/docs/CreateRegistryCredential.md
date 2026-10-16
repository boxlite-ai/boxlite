# CreateRegistryCredential


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**registryHost** | **string** | Registry the login is for | [default to undefined]
**repositoryPrefix** | **string** | Repositories it covers, as whole path segments ending in \&quot;/\&quot;; empty for the whole registry | [optional] [default to '']
**username** | **string** | Username the registry expects | [default to undefined]
**password** | **string** | Password or access token. Never returned. | [default to undefined]

## Example

```typescript
import { CreateRegistryCredential } from './api';

const instance: CreateRegistryCredential = {
    registryHost,
    repositoryPrefix,
    username,
    password,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
