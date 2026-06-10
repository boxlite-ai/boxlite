# TraceSpan


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**traceId** | **string** | Trace identifier | [default to undefined]
**spanId** | **string** | Span identifier | [default to undefined]
**parentSpanId** | **string** | Parent span identifier | [optional] [default to undefined]
**spanName** | **string** | Span name | [default to undefined]
**timestamp** | **string** | Span start timestamp | [default to undefined]
**durationNs** | **number** | Span duration in nanoseconds | [default to undefined]
**spanAttributes** | **{ [key: string]: string; }** | Span attributes | [default to undefined]
**statusCode** | **string** | Status code of the span | [optional] [default to undefined]
**statusMessage** | **string** | Status message | [optional] [default to undefined]

## Example

```typescript
import { TraceSpan } from './api';

const instance: TraceSpan = {
    traceId,
    spanId,
    parentSpanId,
    spanName,
    timestamp,
    durationNs,
    spanAttributes,
    statusCode,
    statusMessage,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
