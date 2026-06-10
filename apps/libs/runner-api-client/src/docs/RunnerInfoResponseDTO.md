# RunnerInfoResponseDTO


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**appVersion** | **string** |  | [optional] [default to undefined]
**metrics** | [**RunnerMetrics**](RunnerMetrics.md) |  | [optional] [default to undefined]
**serviceHealth** | [**Array&lt;RunnerServiceInfo&gt;**](RunnerServiceInfo.md) |  | [optional] [default to undefined]

## Example

```typescript
import { RunnerInfoResponseDTO } from './api';

const instance: RunnerInfoResponseDTO = {
    appVersion,
    metrics,
    serviceHealth,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
