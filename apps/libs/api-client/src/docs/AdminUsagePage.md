# AdminUsagePage


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**queryId** | **string** |  | [default to undefined]
**generatedAt** | **Date** |  | [default to undefined]
**expiresAt** | **Date** |  | [default to undefined]
**definitionVersion** | **string** |  | [default to undefined]
**query** | [**AdminUsageQuery**](AdminUsageQuery.md) |  | [default to undefined]
**coverage** | [**AdminUsageCoverage**](AdminUsageCoverage.md) |  | [default to undefined]
**items** | [**Array&lt;AdminUsageItem&gt;**](AdminUsageItem.md) |  | [default to undefined]
**nextCursor** | **string** |  | [default to undefined]

## Example

```typescript
import { AdminUsagePage } from './api';

const instance: AdminUsagePage = {
    queryId,
    generatedAt,
    expiresAt,
    definitionVersion,
    query,
    coverage,
    items,
    nextCursor,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
