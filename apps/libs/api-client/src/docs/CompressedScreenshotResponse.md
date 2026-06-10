# CompressedScreenshotResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**screenshot** | **string** | Base64 encoded compressed screenshot image data | [default to undefined]
**cursorPosition** | **object** | The current cursor position when the compressed screenshot was taken | [optional] [default to undefined]
**sizeBytes** | **number** | The size of the compressed screenshot data in bytes | [optional] [default to undefined]

## Example

```typescript
import { CompressedScreenshotResponse } from './api';

const instance: CompressedScreenshotResponse = {
    screenshot,
    cursorPosition,
    sizeBytes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
