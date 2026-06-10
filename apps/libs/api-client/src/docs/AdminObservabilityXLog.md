# AdminObservabilityXLog


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**source** | **string** |  | [default to undefined]
**timestamp** | **string** |  | [default to undefined]
**serviceName** | **string** |  | [default to undefined]
**body** | **string** |  | [default to undefined]
**severityText** | **string** |  | [optional] [default to undefined]
**traceId** | **string** |  | [optional] [default to undefined]
**spanId** | **string** |  | [optional] [default to undefined]
**executionId** | **string** |  | [optional] [default to undefined]
**jobId** | **string** |  | [optional] [default to undefined]
**stream** | **string** |  | [optional] [default to undefined]
**attributes** | **{ [key: string]: any; }** |  | [optional] [default to undefined]

## Example

```typescript
import { AdminObservabilityXLog } from './api';

const instance: AdminObservabilityXLog = {
    source,
    timestamp,
    serviceName,
    body,
    severityText,
    traceId,
    spanId,
    executionId,
    jobId,
    stream,
    attributes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
