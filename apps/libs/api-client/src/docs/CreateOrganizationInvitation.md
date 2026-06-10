# CreateOrganizationInvitation


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**email** | **string** | Email address of the invitee | [default to undefined]
**role** | **string** | Organization member role for the invitee | [default to RoleEnum_MEMBER]
**assignedRoleIds** | **Array&lt;string&gt;** | Array of assigned role IDs for the invitee | [default to undefined]
**expiresAt** | **Date** | Expiration date of the invitation | [optional] [default to undefined]

## Example

```typescript
import { CreateOrganizationInvitation } from './api';

const instance: CreateOrganizationInvitation = {
    email,
    role,
    assignedRoleIds,
    expiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
