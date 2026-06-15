# SupportedBoxImage


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Stable image option ID shown by the dashboard | [default to undefined]
**name** | **string** | Display name for the supported image | [default to undefined]
**ref** | **string** | Pinned OCI image reference accepted by box creation | [default to undefined]
**isDefault** | **boolean** | Whether this image is used when create omits an image | [default to undefined]

## Example

```typescript
import { SupportedBoxImage } from './api';

const instance: SupportedBoxImage = {
    id,
    name,
    ref,
    isDefault,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
