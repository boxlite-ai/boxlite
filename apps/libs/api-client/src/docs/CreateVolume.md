# CreateVolume


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** |  | [optional] [default to undefined]
**storageBackend** | **string** | The storage backend that owns the volume; defaults to object_storage | [optional] [default to undefined]
**instance** | **string** | The Filestore instance the volume stores its data on; filestore volumes only. Omit to assign from configured instances. | [optional] [default to undefined]

## Example

```typescript
import { CreateVolume } from './api';

const instance: CreateVolume = {
    name,
    storageBackend,
    instance,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
