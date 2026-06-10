# UpdateOrganizationInvitation


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**role** | **string** | Organization member role | [default to undefined]
**assignedRoleIds** | **Array&lt;string&gt;** | Array of role IDs | [default to undefined]
**expiresAt** | **Date** | Expiration date of the invitation | [optional] [default to undefined]

## Example

```typescript
import { UpdateOrganizationInvitation } from './api';

const instance: UpdateOrganizationInvitation = {
    role,
    assignedRoleIds,
    expiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
