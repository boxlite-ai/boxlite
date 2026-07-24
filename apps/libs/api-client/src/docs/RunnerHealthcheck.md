# RunnerHealthcheck


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**runnerEpoch** | **string** | Unique epoch generated when the runner process starts | [default to undefined]
**runnerIncarnation** | **number** | Monotonically increasing process incarnation persisted by the runner | [default to undefined]
**sequence** | **number** | Monotonically increasing healthcheck sequence within the runner epoch | [default to undefined]
**boxes** | [**Array&lt;RunnerBoxObservation&gt;**](RunnerBoxObservation.md) | Complete local box inventory. Omitted when inventory collection fails; an empty array is a successful empty snapshot. | [optional] [default to undefined]
**metrics** | [**RunnerHealthMetrics**](RunnerHealthMetrics.md) | Runner metrics | [optional] [default to undefined]
**serviceHealth** | [**Array&lt;RunnerServiceHealth&gt;**](RunnerServiceHealth.md) | Health status of individual services on the runner | [optional] [default to undefined]
**domain** | **string** | Runner domain | [optional] [default to undefined]
**proxyUrl** | **string** | Runner proxy URL | [optional] [default to undefined]
**apiUrl** | **string** | Runner API URL | [optional] [default to undefined]
**appVersion** | **string** | Runner app version | [default to undefined]

## Example

```typescript
import { RunnerHealthcheck } from './api';

const instance: RunnerHealthcheck = {
    runnerEpoch,
    runnerIncarnation,
    sequence,
    boxes,
    metrics,
    serviceHealth,
    domain,
    proxyUrl,
    apiUrl,
    appVersion,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
