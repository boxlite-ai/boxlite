# DtoVolumeDTO


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**mountPath** | **string** |  | [optional] [default to undefined]
**readOnly** | **boolean** | ReadOnly binds the volume (or its Subpath) into the box read-only. Omitted on the wire means read-write, so an older API that never sends it keeps today\&#39;s behaviour. | [optional] [default to undefined]
**subpath** | **string** |  | [optional] [default to undefined]
**volumeId** | **string** |  | [optional] [default to undefined]

## Example

```typescript
import { DtoVolumeDTO } from './api';

const instance: DtoVolumeDTO = {
    mountPath,
    readOnly,
    subpath,
    volumeId,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
