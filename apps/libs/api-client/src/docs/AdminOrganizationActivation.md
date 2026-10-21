# AdminOrganizationActivation


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**organizationId** | **string** |  | [default to undefined]
**lastBoxCreatedAt** | **Date** | Maximum retained Box creation or warm-pool claim time; survives Box deletion. | [default to undefined]
**boxHistoryComplete** | **boolean** | Whether creation, successful start and accepted deletion tracking covers the organization lifetime. | [default to undefined]
**lastBoxModifiedAt** | **Date** | Maximum observed successful-start or accepted-deletion time; cleanup, stops and label edits do not advance it. | [default to undefined]
**observedAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { AdminOrganizationActivation } from './api';

const instance: AdminOrganizationActivation = {
    organizationId,
    lastBoxCreatedAt,
    boxHistoryComplete,
    lastBoxModifiedAt,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
