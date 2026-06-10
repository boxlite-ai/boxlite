# PaginatedLogs


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**items** | [**Array&lt;LogEntry&gt;**](LogEntry.md) | List of log entries | [default to undefined]
**total** | **number** | Total number of log entries matching the query | [default to undefined]
**page** | **number** | Current page number | [default to undefined]
**totalPages** | **number** | Total number of pages | [default to undefined]

## Example

```typescript
import { PaginatedLogs } from './api';

const instance: PaginatedLogs = {
    items,
    total,
    page,
    totalPages,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
