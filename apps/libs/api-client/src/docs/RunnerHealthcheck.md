# RunnerHealthcheck


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**supportsPrivileged** | **boolean** | Runner preserves the guest privileged creation option | [optional] [default to undefined]
**metrics** | [**RunnerHealthMetrics**](RunnerHealthMetrics.md) | Runner metrics | [optional] [default to undefined]
**serviceHealth** | [**Array&lt;RunnerServiceHealth&gt;**](RunnerServiceHealth.md) | Health status of individual services on the runner | [optional] [default to undefined]
**dataDiskRef** | [**RunnerDataDiskRef**](RunnerDataDiskRef.md) | Cloud identity of the runner data disk; absent when the runner has none (AWS or local) | [optional] [default to undefined]
**domain** | **string** | Runner domain | [optional] [default to undefined]
**proxyUrl** | **string** | Runner proxy URL | [optional] [default to undefined]
**apiUrl** | **string** | Runner API URL | [optional] [default to undefined]
**appVersion** | **string** | Runner app version | [default to undefined]

## Example

```typescript
import { RunnerHealthcheck } from './api';

const instance: RunnerHealthcheck = {
    supportsPrivileged,
    metrics,
    serviceHealth,
    dataDiskRef,
    domain,
    proxyUrl,
    apiUrl,
    appVersion,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
