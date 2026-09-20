# UpdateBoxStateDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**state** | **string** | The new state for the box | [default to undefined]
**errorReason** | **string** | Optional error message when reporting an error state | [optional] [default to undefined]
**recoverable** | **boolean** | Whether the box is recoverable | [optional] [default to undefined]

## Example

```typescript
import { UpdateBoxStateDto } from './api';

const instance: UpdateBoxStateDto = {
    state,
    errorReason,
    recoverable,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
