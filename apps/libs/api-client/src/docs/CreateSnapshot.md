# CreateSnapshot


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | The name of the snapshot | [default to undefined]
**imageName** | **string** | The image name of the snapshot | [optional] [default to undefined]
**entrypoint** | **Array&lt;string&gt;** | The entrypoint command for the snapshot | [optional] [default to undefined]
**general** | **boolean** | Whether the snapshot is general | [optional] [default to undefined]
**cpu** | **number** | CPU cores allocated to the resulting box | [optional] [default to undefined]
**gpu** | **number** | GPU units allocated to the resulting box | [optional] [default to undefined]
**memory** | **number** | Memory allocated to the resulting box in GB | [optional] [default to undefined]
**disk** | **number** | Disk space allocated to the box in GB | [optional] [default to undefined]
**buildInfo** | [**CreateBuildInfo**](CreateBuildInfo.md) | Build information for the snapshot | [optional] [default to undefined]
**regionId** | **string** | ID of the region where the snapshot will be available. Defaults to organization default region if not specified. | [optional] [default to undefined]

## Example

```typescript
import { CreateSnapshot } from './api';

const instance: CreateSnapshot = {
    name,
    imageName,
    entrypoint,
    general,
    cpu,
    gpu,
    memory,
    disk,
    buildInfo,
    regionId,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
