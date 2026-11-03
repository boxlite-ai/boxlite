# RunnerHealthcheck


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**checkpointsEnabled** | **boolean** | Native Linux x86_64 memory checkpoint support; omitted means disabled | [optional] [default to undefined]
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
    checkpointsEnabled,
    metrics,
    serviceHealth,
    domain,
    proxyUrl,
    apiUrl,
    appVersion,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
