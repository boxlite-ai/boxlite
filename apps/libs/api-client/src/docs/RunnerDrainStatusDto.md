# RunnerDrainStatusDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** |  | [default to undefined]
**state** | [**RunnerState**](RunnerState.md) |  | [default to undefined]
**draining** | **boolean** |  | [default to undefined]
**assignedBoxes** | **number** |  | [default to undefined]
**activeMigrations** | **number** | Unfinished migrations involving either side of this runner | [default to undefined]
**pendingJobs** | **number** | Pending or in-progress runner jobs | [default to undefined]

## Example

```typescript
import { RunnerDrainStatusDto } from './api';

const instance: RunnerDrainStatusDto = {
    id,
    state,
    draining,
    assignedBoxes,
    activeMigrations,
    pendingJobs,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
