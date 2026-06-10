# OrganizationInvitation


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Invitation ID | [default to undefined]
**email** | **string** | Email address of the invitee | [default to undefined]
**invitedBy** | **string** | Email address of the inviter | [default to undefined]
**organizationId** | **string** | Organization ID | [default to undefined]
**organizationName** | **string** | Organization name | [default to undefined]
**expiresAt** | **Date** | Expiration date of the invitation | [default to undefined]
**status** | **string** | Invitation status | [default to undefined]
**role** | **string** | Member role | [default to undefined]
**assignedRoles** | [**Array&lt;OrganizationRole&gt;**](OrganizationRole.md) | Assigned roles | [default to undefined]
**createdAt** | **Date** | Creation timestamp | [default to undefined]
**updatedAt** | **Date** | Last update timestamp | [default to undefined]

## Example

```typescript
import { OrganizationInvitation } from './api';

const instance: OrganizationInvitation = {
    id,
    email,
    invitedBy,
    organizationId,
    organizationName,
    expiresAt,
    status,
    role,
    assignedRoles,
    createdAt,
    updatedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
