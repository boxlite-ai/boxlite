# RunnerCpuIncident


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Bigint row ID; keep as a string. | [default to undefined]
**runnerId** | **string** |  | [default to undefined]
**eventId** | **string** |  | [default to undefined]
**highCpuSince** | **Date** |  | [default to undefined]
**windowStartedAt** | **Date** |  | [default to undefined]
**windowEndedAt** | **Date** |  | [default to undefined]
**runnerCpuPercent** | **number** | Host-wide percent at trigger. | [default to undefined]
**boxId** | **string** |  | [default to undefined]
**image** | **string** | Winning box Image string at capture time. | [default to undefined]
**cpuSeconds** | **number** | Measured cumulative CPU-seconds across all cores. | [default to undefined]
**samplingComplete** | **boolean** |  | [default to undefined]
**receivedAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { RunnerCpuIncident } from './api';

const instance: RunnerCpuIncident = {
    id,
    runnerId,
    eventId,
    highCpuSince,
    windowStartedAt,
    windowEndedAt,
    runnerCpuPercent,
    boxId,
    image,
    cpuSeconds,
    samplingComplete,
    receivedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
