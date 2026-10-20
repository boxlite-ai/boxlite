# AdminOrganizationDetail


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**createdAt** | **Date** | Organization creation time. | [default to undefined]
**createdBy** | **string** | Stored creator ID; account linking replaces it with the primary user ID. | [default to undefined]
**creator** | [**AdminOrganizationCreator**](AdminOrganizationCreator.md) | Current creator identity. | [default to undefined]
**organizationId** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**members** | [**AdminOrganizationMemberPage**](AdminOrganizationMemberPage.md) |  | [default to undefined]
**boxes** | [**AdminOrganizationBoxPage**](AdminOrganizationBoxPage.md) |  | [default to undefined]
**impact** | [**AdminOrganizationImpact**](AdminOrganizationImpact.md) |  | [default to undefined]
**usage** | [**AdminOrganizationUsage**](AdminOrganizationUsage.md) |  | [optional] [default to undefined]
**activation** | [**AdminOrganizationActivation**](AdminOrganizationActivation.md) | Only with include&#x3D;activation. | [optional] [default to undefined]
**observedAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { AdminOrganizationDetail } from './api';

const instance: AdminOrganizationDetail = {
    createdAt,
    createdBy,
    creator,
    organizationId,
    name,
    members,
    boxes,
    impact,
    usage,
    activation,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
