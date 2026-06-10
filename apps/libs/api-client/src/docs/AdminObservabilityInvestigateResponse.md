# AdminObservabilityInvestigateResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**resource** | [**AdminObservabilityResourceSummary**](AdminObservabilityResourceSummary.md) |  | [default to undefined]
**correlation** | [**AdminObservabilityCorrelation**](AdminObservabilityCorrelation.md) |  | [default to undefined]
**sources** | [**Array&lt;AdminObservabilitySourceStatus&gt;**](AdminObservabilitySourceStatus.md) |  | [default to undefined]
**traceSpans** | [**Array&lt;TraceSpan&gt;**](TraceSpan.md) |  | [default to undefined]
**logs** | [**Array&lt;LogEntry&gt;**](LogEntry.md) |  | [default to undefined]
**metrics** | [**MetricsResponse**](MetricsResponse.md) |  | [default to undefined]
**boxes** | [**Array&lt;AdminBoxItem&gt;**](AdminBoxItem.md) |  | [default to undefined]
**runners** | [**Array&lt;AdminRunnerItem&gt;**](AdminRunnerItem.md) |  | [default to undefined]
**machines** | [**Array&lt;AdminMachineItem&gt;**](AdminMachineItem.md) |  | [default to undefined]
**auditLogs** | [**Array&lt;AdminObservabilityAuditLog&gt;**](AdminObservabilityAuditLog.md) |  | [default to undefined]
**xlogs** | [**Array&lt;AdminObservabilityXLog&gt;**](AdminObservabilityXLog.md) |  | [default to undefined]
**s3Objects** | [**Array&lt;AdminObservabilityS3Object&gt;**](AdminObservabilityS3Object.md) |  | [default to undefined]
**timeline** | [**Array&lt;AdminObservabilityTimelineEvent&gt;**](AdminObservabilityTimelineEvent.md) |  | [default to undefined]
**operations** | [**Array&lt;AdminObservabilityOperation&gt;**](AdminObservabilityOperation.md) |  | [default to undefined]
**commands** | [**AdminObservabilityCommands**](AdminObservabilityCommands.md) |  | [default to undefined]
**externalLinks** | [**AdminObservabilityExternalLinks**](AdminObservabilityExternalLinks.md) |  | [default to undefined]

## Example

```typescript
import { AdminObservabilityInvestigateResponse } from './api';

const instance: AdminObservabilityInvestigateResponse = {
    resource,
    correlation,
    sources,
    traceSpans,
    logs,
    metrics,
    boxes,
    runners,
    machines,
    auditLogs,
    xlogs,
    s3Objects,
    timeline,
    operations,
    commands,
    externalLinks,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
