# AdminOrganizationMetadataSummary


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**organizationId** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**memberCount** | **number** |  | [default to undefined]
**boxCount** | **number** |  | [default to undefined]
**impactState** | **string** |  | [default to undefined]
**observedAt** | **Date** |  | [default to undefined]
**createdAt** | **Date** | Organization creation time, at millisecond precision. | [default to undefined]
**createdBy** | **string** | Stored creator ID; account linking replaces it with the primary user ID. | [default to undefined]
**creator** | [**AdminOrganizationCreator**](AdminOrganizationCreator.md) |  | [default to undefined]

## Example

```typescript
import { AdminOrganizationMetadataSummary } from './api';

const instance: AdminOrganizationMetadataSummary = {
    organizationId,
    name,
    memberCount,
    boxCount,
    impactState,
    observedAt,
    createdAt,
    createdBy,
    creator,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
