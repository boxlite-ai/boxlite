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
**osUser** | **string** |  | [default to undefined]
**outboundAllowNet** | **Array&lt;string&gt;** |  | [optional] [default to undefined]
**outboundEnabled** | **boolean** | Outbound network policy. outboundEnabled is required: a request without it is rejected rather than started with a guessed policy. | [default to undefined]
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
    osUser,
    outboundAllowNet,
    outboundEnabled,
    secrets,
    storageQuota,
    volumes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
