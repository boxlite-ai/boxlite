# AdminOrganizationDetail


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

## Example

```typescript
import { AdminOrganizationDetail } from './api';

const instance: AdminOrganizationDetail = {
    organizationId,
    name,
    members,
    boxes,
    impact,
    usage,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
