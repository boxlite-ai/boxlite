# AdminOrganizationVerifiedCreator


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**userId** | **string** |  | [default to undefined]
**email** | **string** | Current email, not necessarily the email at registration. | [default to undefined]
**displayName** | **string** |  | [default to undefined]
**emailVerified** | **boolean** | Current verification state from the creator account. | [optional] [default to undefined]

## Example

```typescript
import { AdminOrganizationVerifiedCreator } from './api';

const instance: AdminOrganizationVerifiedCreator = {
    userId,
    email,
    displayName,
    emailVerified,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
