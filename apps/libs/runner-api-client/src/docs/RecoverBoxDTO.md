# RecoverBoxDTO


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**cpuQuota** | **number** |  | [optional] [default to undefined]
**env** | **{ [key: string]: string; }** |  | [optional] [default to undefined]
**errorReason** | **string** |  | [default to undefined]
**fromVolumeId** | **string** |  | [optional] [default to undefined]
**gpuQuota** | **number** |  | [optional] [default to undefined]
**memoryQuota** | **number** |  | [optional] [default to undefined]
**networkAllowList** | **string** |  | [optional] [default to undefined]
**networkBlockAll** | **boolean** |  | [optional] [default to undefined]
**networkRxKbps** | **number** |  | [optional] [default to undefined]
**networkTxKbps** | **number** |  | [optional] [default to undefined]
**osUser** | **string** |  | [default to undefined]
**secrets** | [**Array&lt;DtoSecretDTO&gt;**](DtoSecretDTO.md) |  | [optional] [default to undefined]
**storageQuota** | **number** |  | [optional] [default to undefined]
**volumes** | [**Array&lt;DtoVolumeDTO&gt;**](DtoVolumeDTO.md) |  | [optional] [default to undefined]

## Example

```typescript
import { RecoverBoxDTO } from './api';

const instance: RecoverBoxDTO = {
    cpuQuota,
    env,
    errorReason,
    fromVolumeId,
    gpuQuota,
    memoryQuota,
    networkAllowList,
    networkBlockAll,
    networkRxKbps,
    networkTxKbps,
    osUser,
    secrets,
    storageQuota,
    volumes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
