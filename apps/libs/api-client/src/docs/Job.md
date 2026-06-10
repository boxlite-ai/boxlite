# Job


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | The ID of the job | [default to undefined]
**type** | [**JobType**](JobType.md) | The type of the job | [default to undefined]
**status** | [**JobStatus**](JobStatus.md) | The status of the job | [default to undefined]
**resourceType** | **string** | The type of resource this job operates on | [default to undefined]
**resourceId** | **string** | The ID of the resource this job operates on (boxId, snapshotRef, etc.) | [default to undefined]
**payload** | **string** | Job-specific JSON-encoded payload data (operational metadata) | [optional] [default to undefined]
**traceContext** | **{ [key: string]: any; }** | OpenTelemetry trace context for distributed tracing (W3C Trace Context format) | [optional] [default to undefined]
**errorMessage** | **string** | Error message if the job failed | [optional] [default to undefined]
**createdAt** | **string** | The creation timestamp of the job | [default to undefined]
**updatedAt** | **string** | The last update timestamp of the job | [optional] [default to undefined]

## Example

```typescript
import { Job } from './api';

const instance: Job = {
    id,
    type,
    status,
    resourceType,
    resourceId,
    payload,
    traceContext,
    errorMessage,
    createdAt,
    updatedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
