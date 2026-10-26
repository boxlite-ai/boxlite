# AdminOrganizationActivation


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**organizationId** | **string** |  | [default to undefined]
**lastBoxCreatedAt** | **Date** | Maximum retained Box creation or warm-pool claim time; survives Box deletion. Null means none was recorded; organizations older than tracking only have retained creation times. | [default to undefined]
**lastBoxModifiedAt** | **Date** | Maximum observed successful-start or accepted-deletion time; cleanup, stops and label edits do not advance it. Null means none was recorded since tracking began. | [default to undefined]
**observedAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { AdminOrganizationActivation } from './api';

const instance: AdminOrganizationActivation = {
    organizationId,
    lastBoxCreatedAt,
    lastBoxModifiedAt,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
