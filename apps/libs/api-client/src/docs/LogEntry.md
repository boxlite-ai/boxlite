# LogEntry


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**timestamp** | **string** | Timestamp of the log entry | [default to undefined]
**body** | **string** | Log message body | [default to undefined]
**severityText** | **string** | Severity level text (e.g., INFO, WARN, ERROR) | [default to undefined]
**severityNumber** | **number** | Severity level number | [optional] [default to undefined]
**serviceName** | **string** | Service name that generated the log | [default to undefined]
**resourceAttributes** | **{ [key: string]: string; }** | Resource attributes from OTEL | [default to undefined]
**logAttributes** | **{ [key: string]: string; }** | Log-specific attributes | [default to undefined]
**traceId** | **string** | Associated trace ID if available | [optional] [default to undefined]
**spanId** | **string** | Associated span ID if available | [optional] [default to undefined]

## Example

```typescript
import { LogEntry } from './api';

const instance: LogEntry = {
    timestamp,
    body,
    severityText,
    severityNumber,
    serviceName,
    resourceAttributes,
    logAttributes,
    traceId,
    spanId,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
