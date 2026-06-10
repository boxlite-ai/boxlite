# AdminObservabilityAuditLog


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** |  | [default to undefined]
**actorId** | **string** |  | [default to undefined]
**actorEmail** | **string** |  | [default to undefined]
**organizationId** | **string** |  | [optional] [default to undefined]
**action** | **string** |  | [default to undefined]
**targetType** | **string** |  | [optional] [default to undefined]
**targetId** | **string** |  | [optional] [default to undefined]
**statusCode** | **number** |  | [optional] [default to undefined]
**errorMessage** | **string** |  | [optional] [default to undefined]
**source** | **string** |  | [optional] [default to undefined]
**metadata** | **{ [key: string]: any; }** |  | [optional] [default to undefined]
**createdAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { AdminObservabilityAuditLog } from './api';

const instance: AdminObservabilityAuditLog = {
    id,
    actorId,
    actorEmail,
    organizationId,
    action,
    targetType,
    targetId,
    statusCode,
    errorMessage,
    source,
    metadata,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
