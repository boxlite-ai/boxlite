# MouseScrollRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**x** | **number** | The X coordinate where to perform the scroll operation | [default to undefined]
**y** | **number** | The Y coordinate where to perform the scroll operation | [default to undefined]
**direction** | **string** | The scroll direction (up, down) | [default to undefined]
**amount** | **number** | The number of scroll units to scroll. Defaults to 1 | [optional] [default to undefined]

## Example

```typescript
import { MouseScrollRequest } from './api';

const instance: MouseScrollRequest = {
    x,
    y,
    direction,
    amount,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
