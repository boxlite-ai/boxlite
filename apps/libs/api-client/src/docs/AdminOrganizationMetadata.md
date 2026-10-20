# AdminOrganizationMetadata


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**organizationId** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**members** | [**AdminOrganizationMemberPage**](AdminOrganizationMemberPage.md) |  | [default to undefined]
**boxes** | [**AdminOrganizationBoxPage**](AdminOrganizationBoxPage.md) |  | [default to undefined]
**impact** | [**AdminOrganizationImpact**](AdminOrganizationImpact.md) |  | [default to undefined]
**usage** | [**AdminOrganizationUsage**](AdminOrganizationUsage.md) |  | [optional] [default to undefined]
**observedAt** | **Date** |  | [default to undefined]
**createdAt** | **Date** | Organization creation time, at millisecond precision. | [default to undefined]
**createdBy** | **string** | Stored creator ID; account linking replaces it with the primary user ID. | [default to undefined]
**creator** | [**AdminOrganizationCreator**](AdminOrganizationCreator.md) |  | [default to undefined]

## Example

```typescript
import { AdminOrganizationMetadata } from './api';

const instance: AdminOrganizationMetadata = {
    organizationId,
    name,
    members,
    boxes,
    impact,
    usage,
    observedAt,
    createdAt,
    createdBy,
    creator,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
