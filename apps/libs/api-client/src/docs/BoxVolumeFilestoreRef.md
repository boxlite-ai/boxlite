# BoxVolumeFilestoreRef


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**instance** | **string** | Filestore instance logical name selected from the API configuration | [default to undefined]
**server** | **string** | NFS server address resolved from GCP Filestore | [default to undefined]
**_export** | **string** | NFS export path on the server | [default to undefined]

## Example

```typescript
import { BoxVolumeFilestoreRef } from './api';

const instance: BoxVolumeFilestoreRef = {
    instance,
    server,
    _export,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
