# RunnerBoxObservation


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**boxId** | **string** | Control-plane box ID observed on the runner | [default to undefined]
**actualState** | [**BoxState**](BoxState.md) | Actual box state observed by the runner | [default to undefined]
**runtimeGeneration** | **number** | Control-plane runtime generation associated with the observed instance. Zero means the runner cannot provide generation evidence. | [default to undefined]

## Example

```typescript
import { RunnerBoxObservation } from './api';

const instance: RunnerBoxObservation = {
    boxId,
    actualState,
    runtimeGeneration,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
