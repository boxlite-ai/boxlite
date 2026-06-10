# BoxVolume


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**volumeId** | **string** | The ID of the volume | [default to undefined]
**mountPath** | **string** | The mount path for the volume | [default to undefined]
**subpath** | **string** | Optional subpath within the volume to mount. When specified, only this S3 prefix will be accessible. When omitted, the entire volume is mounted. | [optional] [default to undefined]

## Example

```typescript
import { BoxVolume } from './api';

const instance: BoxVolume = {
    volumeId,
    mountPath,
    subpath,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
