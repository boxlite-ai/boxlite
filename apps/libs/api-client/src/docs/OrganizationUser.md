# OrganizationUser


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**userId** | **string** | User ID | [default to undefined]
**organizationId** | **string** | Organization ID | [default to undefined]
**name** | **string** | User name | [default to undefined]
**email** | **string** | User email | [default to undefined]
**role** | **string** | Member role | [default to undefined]
**assignedRoles** | [**Array&lt;OrganizationRole&gt;**](OrganizationRole.md) | Roles assigned to the user | [default to undefined]
**createdAt** | **Date** | Creation timestamp | [default to undefined]
**updatedAt** | **Date** | Last update timestamp | [default to undefined]

## Example

```typescript
import { OrganizationUser } from './api';

const instance: OrganizationUser = {
    userId,
    organizationId,
    name,
    email,
    role,
    assignedRoles,
    createdAt,
    updatedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
