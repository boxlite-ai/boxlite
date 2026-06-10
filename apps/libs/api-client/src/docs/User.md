# User


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | User ID | [default to undefined]
**name** | **string** | User name | [default to undefined]
**email** | **string** | User email | [default to undefined]
**publicKeys** | [**Array&lt;UserPublicKey&gt;**](UserPublicKey.md) | User public keys | [default to undefined]
**createdAt** | **Date** | Creation timestamp | [default to undefined]

## Example

```typescript
import { User } from './api';

const instance: User = {
    id,
    name,
    email,
    publicKeys,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
