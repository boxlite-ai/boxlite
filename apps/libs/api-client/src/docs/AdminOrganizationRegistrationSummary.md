# AdminOrganizationRegistrationSummary


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**createdAt** | **Date** | Organization creation time. | [default to undefined]
**createdBy** | **string** | Stored creator ID; account linking replaces it with the primary user ID. | [default to undefined]
**creator** | [**AdminOrganizationVerifiedCreator**](AdminOrganizationVerifiedCreator.md) | Current creator identity. | [default to undefined]
**organizationId** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**observedAt** | **Date** | Last business modification, not query time. | [default to undefined]

## Example

```typescript
import { AdminOrganizationRegistrationSummary } from './api';

const instance: AdminOrganizationRegistrationSummary = {
    createdAt,
    createdBy,
    creator,
    organizationId,
    name,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
