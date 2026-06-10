# MouseClickRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**x** | **number** | The X coordinate where to perform the mouse click | [default to undefined]
**y** | **number** | The Y coordinate where to perform the mouse click | [default to undefined]
**button** | **string** | The mouse button to click (left, right, middle). Defaults to left | [optional] [default to undefined]
**_double** | **boolean** | Whether to perform a double-click instead of a single click | [optional] [default to undefined]

## Example

```typescript
import { MouseClickRequest } from './api';

const instance: MouseClickRequest = {
    x,
    y,
    button,
    _double,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
