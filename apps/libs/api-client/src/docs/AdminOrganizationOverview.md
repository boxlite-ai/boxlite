# AdminOrganizationOverview


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**createdAt** | **Date** | Organization creation time. | [default to undefined]
**createdBy** | **string** | Stored creator ID; account linking replaces it with the primary user ID. | [default to undefined]
**creator** | [**AdminOrganizationCreator**](AdminOrganizationCreator.md) | Current creator identity. | [default to undefined]
**organizationId** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**memberCount** | **number** |  | [default to undefined]
**boxCount** | **number** |  | [default to undefined]
**impactState** | **string** |  | [default to undefined]
**observedAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { AdminOrganizationOverview } from './api';

const instance: AdminOrganizationOverview = {
    createdAt,
    createdBy,
    creator,
    organizationId,
    name,
    memberCount,
    boxCount,
    impactState,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
