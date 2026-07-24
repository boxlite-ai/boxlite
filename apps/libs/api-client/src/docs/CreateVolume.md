# CreateVolume


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** |  | [default to undefined]
**backend** | **string** |  | [optional] [default to BackendEnum_S3]
**sizeGiB** | **number** |  | [optional] [default to 10]

## Example

```typescript
import { CreateVolume } from './api';

const instance: CreateVolume = {
    name,
    backend,
    sizeGiB,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
