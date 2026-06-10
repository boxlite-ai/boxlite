# TraceSummary


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**traceId** | **string** | Unique trace identifier | [default to undefined]
**rootSpanName** | **string** | Name of the root span | [default to undefined]
**startTime** | **string** | Trace start time | [default to undefined]
**endTime** | **string** | Trace end time | [default to undefined]
**durationMs** | **number** | Total duration in milliseconds | [default to undefined]
**spanCount** | **number** | Number of spans in this trace | [default to undefined]
**statusCode** | **string** | Status code of the trace | [optional] [default to undefined]

## Example

```typescript
import { TraceSummary } from './api';

const instance: TraceSummary = {
    traceId,
    rootSpanName,
    startTime,
    endTime,
    durationMs,
    spanCount,
    statusCode,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
