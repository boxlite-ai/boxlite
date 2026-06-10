# RunnerServiceHealth


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**serviceName** | **string** | Name of the service being checked | [default to undefined]
**healthy** | **boolean** | Whether the service is healthy | [default to undefined]
**errorReason** | **string** | Error reason if the service is unhealthy | [optional] [default to undefined]

## Example

```typescript
import { RunnerServiceHealth } from './api';

const instance: RunnerServiceHealth = {
    serviceName,
    healthy,
    errorReason,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
