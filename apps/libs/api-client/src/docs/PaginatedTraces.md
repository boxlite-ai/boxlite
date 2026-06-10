# PaginatedTraces


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**items** | [**Array&lt;TraceSummary&gt;**](TraceSummary.md) | List of trace summaries | [default to undefined]
**total** | **number** | Total number of traces matching the query | [default to undefined]
**page** | **number** | Current page number | [default to undefined]
**totalPages** | **number** | Total number of pages | [default to undefined]

## Example

```typescript
import { PaginatedTraces } from './api';

const instance: PaginatedTraces = {
    items,
    total,
    page,
    totalPages,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
