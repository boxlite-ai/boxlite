# AdminOrganizationActivation


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**organizationId** | **string** |  | [default to undefined]
**firstObservedBoxCreatedAt** | **Date** | Earliest retained creation or warm-pool claim; a true first only when boxHistoryComplete is true. | [default to undefined]
**boxHistoryComplete** | **boolean** | False for older organizations and organizations receiving transferred Boxes. | [default to undefined]
**firstRecordedComputeAt** | **Date** | Earliest recorded positive-CPU allocation period. Null does not prove no execution. | [default to undefined]
**computeHistoryComplete** | **boolean** | Always false: usage events can have historical gaps. | [default to undefined]
**observedAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { AdminOrganizationActivation } from './api';

const instance: AdminOrganizationActivation = {
    organizationId,
    firstObservedBoxCreatedAt,
    boxHistoryComplete,
    firstRecordedComputeAt,
    computeHistoryComplete,
    observedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
