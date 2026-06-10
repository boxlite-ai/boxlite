# MouseDragRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**startX** | **number** | The starting X coordinate for the drag operation | [default to undefined]
**startY** | **number** | The starting Y coordinate for the drag operation | [default to undefined]
**endX** | **number** | The ending X coordinate for the drag operation | [default to undefined]
**endY** | **number** | The ending Y coordinate for the drag operation | [default to undefined]
**button** | **string** | The mouse button to use for dragging (left, right, middle). Defaults to left | [optional] [default to undefined]

## Example

```typescript
import { MouseDragRequest } from './api';

const instance: MouseDragRequest = {
    startX,
    startY,
    endX,
    endY,
    button,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
