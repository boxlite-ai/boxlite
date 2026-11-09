# RunnerMemoryIncident


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Bigint row ID; keep as a string. | [default to undefined]
**runnerId** | **string** |  | [default to undefined]
**eventId** | **string** |  | [default to undefined]
**sampledAt** | **Date** |  | [default to undefined]
**runnerMemoryPercent** | **number** |  | [default to undefined]
**boxes** | [**Array&lt;BoxMemoryUsageDto&gt;**](BoxMemoryUsageDto.md) | Only Boxes whose maximum in the query range belongs to this snapshot; ties use the smaller row ID. | [default to undefined]
**samplingComplete** | **boolean** |  | [default to undefined]
**receivedAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { RunnerMemoryIncident } from './api';

const instance: RunnerMemoryIncident = {
    id,
    runnerId,
    eventId,
    sampledAt,
    runnerMemoryPercent,
    boxes,
    samplingComplete,
    receivedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
