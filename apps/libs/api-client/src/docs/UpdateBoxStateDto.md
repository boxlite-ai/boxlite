# UpdateBoxStateDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**state** | **string** | The new state for the box | [default to undefined]
**errorReason** | **string** | Optional error message when reporting an error state | [optional] [default to undefined]
**recoverable** | **boolean** | Whether the box is recoverable | [optional] [default to undefined]
**imageDigest** | **string** | Registry digest of the image the box booted from | [optional] [default to undefined]
**imageSizeBytes** | **number** | Declared on-registry size of that image, in bytes | [optional] [default to undefined]

## Example

```typescript
import { UpdateBoxStateDto } from './api';

const instance: UpdateBoxStateDto = {
    state,
    errorReason,
    recoverable,
    imageDigest,
    imageSizeBytes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
