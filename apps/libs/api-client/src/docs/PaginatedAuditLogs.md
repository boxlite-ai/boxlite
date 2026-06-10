# PaginatedAuditLogs


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**items** | [**Array&lt;AuditLog&gt;**](AuditLog.md) |  | [default to undefined]
**total** | **number** |  | [default to undefined]
**page** | **number** |  | [default to undefined]
**totalPages** | **number** |  | [default to undefined]
**nextToken** | **string** | Token for next page in cursor-based pagination | [optional] [default to undefined]

## Example

```typescript
import { PaginatedAuditLogs } from './api';

const instance: PaginatedAuditLogs = {
    items,
    total,
    page,
    totalPages,
    nextToken,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
