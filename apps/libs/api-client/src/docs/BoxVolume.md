# BoxVolume


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**volumeId** | **string** | The ID of the volume (bucket-backed or Filestore-backed) | [default to undefined]
**mountPath** | **string** | The mount path for the volume | [default to undefined]
**filestore** | [**BoxVolumeFilestoreRef**](BoxVolumeFilestoreRef.md) | The Filestore instance reference; absent for bucket-backed volumes | [optional] [default to undefined]
**subpath** | **string** | Optional relative subdirectory within the volume. Cloud read-write mounts create a missing subpath; cloud read-only mounts fail without creating it. When omitted, the entire volume is mounted. | [optional] [default to undefined]
**readOnly** | **boolean** | Mount this Box read-only. The mount is enforced by the runtime, not only by the guest mount flags. Defaults to false. | [optional] [default to undefined]

## Example

```typescript
import { BoxVolume } from './api';

const instance: BoxVolume = {
    volumeId,
    mountPath,
    filestore,
    subpath,
    readOnly,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
